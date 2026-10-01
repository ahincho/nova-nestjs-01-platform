import { createServer, type Server } from 'node:http';
import {
  Controller,
  Get,
  Module,
  NotFoundException,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { fetch } from 'undici';
import { DEFAULT_HEALTH_PATH } from '../health';
import { HttpClientService } from '../http';
import { NovaModule } from '../nova.module';

@Controller('courses')
class CoursesController {
  @Get()
  list(): { id: string }[] {
    return [{ id: '1' }];
  }
}

/** Una URL donde no escucha nadie: el upstream caído de las pruebas. */
let downUrl = '';

@Controller('failures')
class FailuresController {
  constructor(private readonly http: HttpClientService) {}

  @Get('internal')
  internal(): never {
    throw new Error('boom');
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('Course not found');
  }

  @Get('upstream')
  upstream(): Promise<unknown> {
    return this.http.get(`${downUrl}/courses/7`, { timeoutMs: 500 });
  }
}

type LogLine = Record<string, unknown> & {
  req?: { id?: string; url?: string };
  res?: { statusCode?: number };
  err?: Record<string, unknown>;
};

const lines: LogLine[] = [];

// pino escribe al descriptor 1 con sonic-boom, así que sustituir
// `process.stdout.write` no intercepta nada: hay que darle un destino.
const destination = {
  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('{')) {
        lines.push(JSON.parse(line) as LogLine);
      }
    }
  },
};

@Module({
  imports: [NovaModule.forRoot({ observability: { logger: { destination } } })],
  controllers: [CoursesController, FailuresController],
})
class TestModule {}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

/** Un puerto que se abre y se cierra enseguida, así que nadie escucha ahí. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Levanta la aplicación como lo hace `bootstrap()` -- mismo prefijo global,
 * mismas exclusiones, mismo logger -- y devuelve las líneas que pino escribió.
 *
 * Se leen de `process.stdout` en vez de pasarle un destino a pino porque lo que
 * se quiere comprobar es lo que sale del contenedor, que es lo que el
 * recolector termina indexando.
 */
async function boot(): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create(TestModule, { bufferLogs: true });

  // Igual que `bootstrap()`: mismo prefijo global, mismas exclusiones, mismo
  // logger resuelto del contenedor.
  app.setGlobalPrefix('api/v1', {
    exclude: [`${DEFAULT_HEALTH_PATH}/live`, `${DEFAULT_HEALTH_PATH}/ready`],
  });
  app.useLogger(app.get(Logger));

  // Escucha de verdad en vez de inyectar la petición: lo que se comprueba es el
  // camino completo, middleware incluido, que es donde vive la trampa.
  await app.listen(0, '127.0.0.1');

  return { app, base: await app.getUrl() };
}

describe('request logging', () => {
  let app: INestApplication;
  let base: string;

  async function call(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<number> {
    const response = await fetch(`${base}${path}`, { headers });
    await response.text();
    return response.status;
  }

  beforeEach(async () => {
    lines.length = 0;
    ({ app, base } = await boot());
  });

  afterEach(async () => {
    await app.close();
  });

  function completed(url: string): LogLine | undefined {
    return lines.find((line) => line.req?.url === url);
  }

  it('logs an ordinary request as one JSON document', async () => {
    expect(await call('/api/v1/courses')).toBe(200);

    const line = completed('/api/v1/courses');

    expect(line).toBeDefined();
    expect(line?.res?.statusCode).toBe(200);
    expect(line?.msg).toBe('request completed');
    // El nivel va numérico, que es la forma nativa de pino y por la que están
    // escritos los filtros del índice -- 30 info, 40 warn, 50 error.
    expect(line?.level).toBe(30);
  });

  // La trampa que el propio `LoggerModule` documenta: una ruta excluida del
  // prefijo global se sirve fuera de él, y NestJS sólo devuelve a la lista del
  // middleware las que reconoce como comodín. Una sonda sin log es justo la
  // línea que alguien busca cuando una tarea se desregistra sola.
  it('logs the probes, which are served outside the global prefix', async () => {
    expect(await call('/health/ready')).toBe(200);

    expect(completed('/health/ready')).toBeDefined();
  });

  it('logs the liveness probe too', async () => {
    expect(await call('/health/live')).toBe(200);

    expect(completed('/health/live')).toBeDefined();
  });

  // Un id solo tiene que seguir a la llamada entre servicios; que cada salto
  // invente el suyo rompe la traza en cada frontera.
  it('carries the correlation id the caller sent into the log line', async () => {
    await call('/api/v1/courses', { 'x-request-id': 'req-from-caller' });

    expect(completed('/api/v1/courses')?.req?.id).toBe('req-from-caller');
  });

  // Un índice de logs lo lee más gente que la base de datos que ese token
  // protege, y un token pegado en un buscador es una credencial que funciona.
  it('redacts the authorization header', async () => {
    await call('/api/v1/courses', { authorization: 'Bearer a-live-token' });

    const serialised = JSON.stringify(completed('/api/v1/courses'));

    expect(serialised).not.toContain('a-live-token');
    expect(serialised).toContain('[redacted]');
  });

  // Lo que se comprueba acá es lo que llega al índice: una línea de error por
  // fallo, con un mensaje que agrupa y el stack donde el índice lo busca.
  describe('a failed request', () => {
    beforeAll(async () => {
      downUrl = `http://127.0.0.1:${await closedPort()}`;
    });

    function of(id: string): LogLine[] {
      return lines.filter((line) => line.req?.id === id);
    }

    function at(id: string, level: number): LogLine[] {
      return of(id).filter((line) => line.level === level);
    }

    it('logs a 5xx once, with the stack in err and not in the message', async () => {
      expect(
        await call('/api/v1/failures/internal', { 'x-request-id': 'req-500' }),
      ).toBe(500);

      const errors = at('req-500', 50);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        context: 'AllExceptionsFilter',
        msg: 'boom',
        statusCode: 500,
        traceId: 'req-500',
      });
      expect(errors[0]?.err).toEqual({
        type: 'Error',
        message: 'boom',
        stack: expect.stringContaining('Error: boom'),
      });
    });

    it('keeps the line of the request free of an invented error', async () => {
      await call('/api/v1/failures/internal', { 'x-request-id': 'req-500' });

      const request = of('req-500').find(
        (line) => line.msg === 'request errored',
      );

      expect(request?.res?.statusCode).toBe(500);
      expect(request?.level).toBe(30);
      expect(request).not.toHaveProperty('err');
    });

    it('logs a 4xx as a warning with its message and no stack', async () => {
      expect(
        await call('/api/v1/failures/missing', { 'x-request-id': 'req-404' }),
      ).toBe(404);

      const warnings = at('req-404', 40);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.msg).toBe('Course not found');
      expect(warnings[0]).not.toHaveProperty('err');
    });

    // El cliente HTTP no registra: la excepción lleva los campos y el filtro
    // deja la única línea, con la clasificación y la llamada.
    it('logs an upstream failure once, from the filter', async () => {
      expect(
        await call('/api/v1/failures/upstream', { 'x-request-id': 'req-502' }),
      ).toBe(502);

      const errors = at('req-502', 50);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        context: 'AllExceptionsFilter',
        msg: 'Upstream service error',
        upstream: { category: 'connectivity', type: 'connection_refused' },
        outbound: {
          method: 'GET',
          url: `${downUrl}/courses/7`,
          timeoutMs: 500,
        },
        err: { type: 'UpstreamException' },
      });
    });
  });
});
