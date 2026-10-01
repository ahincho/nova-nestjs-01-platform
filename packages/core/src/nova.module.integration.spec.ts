import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import {
  ApplicationError,
  DomainError,
  InfrastructureError,
  Layer,
  NovaErrorStatusMapper,
  type ErrorCatalog,
  type ErrorSerializer,
  type ErrorStatusMapper,
} from './errors';
import { statusToErrorMessage } from './api-standard/error-message';
import { NovaModule, type NovaModuleOptions } from './nova.module';
import type { MockInstance } from 'vitest';

/** El sobre de Nova, como lo lee un cliente. */
type Envelope = {
  success: boolean;
  status: number;
  data: unknown;
  errors: { code: string; message: string; field: string | null }[];
  metadata?: { traceId: string | null };
};

/** El cuerpo que escribe el serializador de ejemplo, en formato RFC 7807. */
type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  traceId: string | undefined;
};

type Answer<TBody = Envelope> = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: TBody;
};

type LogDetail = Record<string, unknown>;

@Controller('orders')
class OrdersController {
  @Get('missing')
  missing(): never {
    throw DomainError.notFound('Pedido no encontrado', {
      code: 'ORDER_NOT_FOUND',
    });
  }

  @Get('taken')
  taken(): never {
    throw DomainError.conflict('El pedido ya fue cancelado');
  }

  @Get('invalid')
  invalid(): never {
    throw ApplicationError.invalidInput('La entrada no es válida', [
      { field: 'periodId', message: 'Debe ser un entero' },
      { field: 'studentId', message: 'No puede estar vacío' },
    ]);
  }

  @Get('running')
  running(): never {
    throw ApplicationError.conflict('La operación sigue en curso', {
      retryAfter: 1,
    });
  }

  @Get('busy')
  busy(): never {
    throw ApplicationError.rateLimited('Demasiadas solicitudes', {
      retryAfter: 30,
    });
  }

  // El error nace después de un await: el contexto de la petición tiene que
  // seguir ahí para que tome su traceId.
  @Get('slow')
  async slow(): Promise<never> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    throw InfrastructureError.timeout('academic-orchestrator');
  }

  @Get('down')
  down(): never {
    throw InfrastructureError.unavailable('payments');
  }

  @Get('boom')
  boom(): never {
    throw new TypeError('Cannot read properties of undefined');
  }

  @Get('legacy')
  legacy(): never {
    throw new NotFoundException('Curso no encontrado');
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

/** Una llamada con `node:http`, que ningún test reemplaza como pasa con `fetch`. */
function call<TBody = Envelope>(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string> = {},
  payload?: string,
): Promise<Answer<TBody>> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: JSON.parse(text) as TBody,
        });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function get<TBody = Envelope>(
  url: string,
  headers: Record<string, string> = {},
): Promise<Answer<TBody>> {
  return call<TBody>('GET', url, headers);
}

/** Un POST con un cuerpo JSON armado a mano, para poder mandarlo roto. */
function post(url: string, payload: string): Promise<Answer> {
  return call('POST', url, { 'content-type': 'application/json' }, payload);
}

async function start(options: NovaModuleOptions): Promise<{
  app: INestApplication;
  url: string;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [NovaModule.forRoot(options)],
    controllers: [OrdersController],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

// De punta a punta: el middleware abre el contexto, el controlador lanza, y el
// filtro contesta con los puertos que declaró `NovaModule.forRoot`.
describe('the errors of a Nova service', () => {
  let warnLog: MockInstance;
  let errorLog: MockInstance;

  beforeEach(() => {
    warnLog = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with the Nova ports', () => {
    let app: INestApplication;
    let url: string;

    beforeAll(async () => {
      ({ app, url } = await start({}));
    });

    afterAll(async () => {
      await app.close();
    });

    // Los casos de la suite de contrato de ADR-031 que los tres stacks tienen
    // que contestar igual, ahora por HTTP y no contra un doble del servidor. En
    // todos: `success: false`, el `status` del cuerpo igual al HTTP, y un
    // `metadata.traceId` que es el mismo id que el servicio devuelve en la
    // cabecera.
    it.each([
      ['/orders/missing', 404, 'ORDER_NOT_FOUND'],
      ['/orders/taken', 409, 'CONFLICT'],
      ['/orders/invalid', 400, 'BAD_REQUEST'],
      ['/orders/running', 409, 'CONFLICT'],
      ['/orders/busy', 429, 'TOO_MANY_REQUESTS'],
      ['/orders/slow', 504, 'GATEWAY_TIMEOUT'],
      ['/orders/down', 503, 'SERVICE_UNAVAILABLE'],
      ['/orders/boom', 500, 'INTERNAL_SERVER_ERROR'],
    ])('answers GET %s with %i %s', async (path, status, code) => {
      const answer = await get(`${url}${path}`);

      expect(answer.status).toBe(status);
      expect(answer.body.success).toBe(false);
      expect(answer.body.status).toBe(status);
      expect(answer.body.data).toBeNull();
      expect(answer.body.errors[0]?.code).toBe(code);
      expect(answer.body.metadata?.traceId).toEqual(expect.any(String));
      expect(answer.body.metadata?.traceId).toBe(
        answer.headers['x-request-id'],
      );
    });

    it('answers a domain error with its own code and the traceId it was born with', async () => {
      const answer = await get(`${url}/orders/missing`, {
        'x-request-id': 'trace-e2e',
      });

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({
        success: false,
        status: 404,
        data: null,
        errors: [
          {
            code: 'ORDER_NOT_FOUND',
            message: 'Pedido no encontrado',
            field: null,
          },
        ],
        metadata: { traceId: 'trace-e2e' },
      });
      // El mismo valor que el servicio devuelve en la cabecera.
      expect(answer.headers['x-request-id']).toBe('trace-e2e');
    });

    it('answers an invalid input with one entry per field', async () => {
      const answer = await get(`${url}/orders/invalid`);

      expect(answer.body.errors).toEqual([
        {
          code: 'BAD_REQUEST',
          message: 'Debe ser un entero',
          field: 'periodId',
        },
        {
          code: 'BAD_REQUEST',
          message: 'No puede estar vacío',
          field: 'studentId',
        },
      ]);
    });

    it('keeps the traceId of an error born after an await', async () => {
      const answer = await get(`${url}/orders/slow`);

      expect(answer.status).toBe(504);
      expect(answer.body.errors[0]?.code).toBe('GATEWAY_TIMEOUT');
      expect(answer.body.metadata?.traceId).toBe(
        answer.headers['x-request-id'],
      );
      expect(JSON.stringify(answer.body)).not.toContain('academic');
    });

    it.each([
      ['/orders/running', '1'],
      ['/orders/busy', '30'],
    ])('sends Retry-After on GET %s', async (path, seconds) => {
      const answer = await get(`${url}${path}`);

      expect(answer.headers['retry-after']).toBe(seconds);
    });

    it('sends no Retry-After when the error does not say how long to wait', async () => {
      const answer = await get(`${url}/orders/taken`);

      expect(answer.headers).not.toHaveProperty('retry-after');
    });

    // Un 5xx no cuenta qué falló por dentro: ni el proveedor, ni el mensaje de
    // la excepción. Con el mensaje genérico y el código de su status alcanza
    // para saber si conviene reintentar.
    it.each([
      ['/orders/slow', 'academic-orchestrator'],
      ['/orders/down', 'payments'],
      ['/orders/boom', 'Cannot read properties'],
    ])('does not reveal what failed inside on GET %s', async (path, secret) => {
      const answer = await get(`${url}${path}`);

      expect(answer.body.errors[0]?.message).toBe(
        statusToErrorMessage(answer.status),
      );
      expect(JSON.stringify(answer)).not.toContain(secret);
    });

    // La otra mitad del caso del proveedor: el cuerpo no lo nombra, el log sí,
    // y con el mismo id que el cuerpo.
    it('names the upstream in the log, with the traceId of the body', async () => {
      const answer = await get(`${url}/orders/slow`);

      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.lastCall?.[0] as LogDetail).toMatchObject({
        traceId: answer.body.metadata?.traceId,
        layer: Layer.INFRASTRUCTURE,
        code: 'GATEWAY_TIMEOUT',
        // Siempre un objeto (ADR-035): un campo con dos formas rechaza líneas
        // enteras en el índice de logs.
        upstream: { upstream: 'academic-orchestrator' },
      });
    });

    // Un cuerpo que no se puede leer falla antes de que el middleware abra el
    // contexto de la petición: ni el error ni la petición tienen id. El cliente
    // no se va sin algo que citar, y el log lleva el mismo valor que el cuerpo.
    it('answers a body that does not parse with a traceId of its own', async () => {
      const answer = await post(`${url}/orders/echo`, '{ "periodId": ');

      expect(answer.status).toBe(400);
      expect(answer.body.errors[0]?.code).toBe('BAD_REQUEST');
      expect(answer.body.metadata?.traceId).toEqual(
        expect.stringMatching(/^[0-9a-f-]{36}$/u),
      );
      expect(warnLog.mock.lastCall?.[0] as LogDetail).toMatchObject({
        traceId: answer.body.metadata?.traceId,
        layer: Layer.APPLICATION,
      });
    });

    it('answers an exception of the framework as before, plus the traceId', async () => {
      const answer = await get(`${url}/orders/legacy`);

      expect(answer.status).toBe(404);
      expect(answer.body.errors).toEqual([
        { code: 'NOT_FOUND', message: 'Curso no encontrado', field: null },
      ]);
      expect(answer.body.metadata?.traceId).toBe(
        answer.headers['x-request-id'],
      );
    });
  });

  // ADR-031: un servicio o un perfil reemplaza un puerto sin forkear Nova.
  describe('with a catalog of its own', () => {
    const catalog: ErrorCatalog = {
      describe: (error, status) => ({
        code: `ORG-${status}`,
        message: `Organización: ${error.message}`,
      }),
    };

    let app: INestApplication;
    let url: string;

    beforeAll(async () => {
      ({ app, url } = await start({ errors: { catalog } }));
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers with the codes and texts of that catalog', async () => {
      const answer = await get(`${url}/orders/missing`);

      expect(answer.status).toBe(404);
      expect(answer.body.errors).toEqual([
        {
          code: 'ORG-404',
          message: 'Organización: Pedido no encontrado',
          field: null,
        },
      ]);
      expect(answer.body.metadata?.traceId).toEqual(expect.any(String));
    });
  });

  // Los otros dos puertos, por el mismo camino. El de status decide el HTTP y el
  // catálogo de Nova, que no se reemplazó, le pone el código de ese status; el
  // serializador decide el cuerpo y la cabecera `Content-Type`, que es lo que
  // hace falta para contestar RFC 7807 en vez del sobre de Nova.
  describe('with a status mapper and a serializer of its own', () => {
    const nova = new NovaErrorStatusMapper();

    // Una organización que contesta 422 a todo rechazo de negocio y le deja el
    // resto a Nova.
    const statusMapper: ErrorStatusMapper = {
      statusOf: (error) =>
        error.layer === Layer.DOMAIN ? 422 : nova.statusOf(error),
    };

    // Recibe el fallo ya saneado: un 5xx llega sin el proveedor ni la causa.
    const serializer: ErrorSerializer = {
      serialize: (failure) => ({
        contentType: 'application/problem+json',
        body: {
          type: 'about:blank',
          title: failure.errors[0]?.code,
          status: failure.status,
          detail: failure.errors[0]?.message,
          traceId: failure.traceId,
        },
      }),
    };

    let app: INestApplication;
    let url: string;

    beforeAll(async () => {
      ({ app, url } = await start({ errors: { statusMapper, serializer } }));
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers with the status, the content type and the body of those ports', async () => {
      const answer = await get<Problem>(`${url}/orders/taken`, {
        'x-request-id': 'trace-7807',
      });

      expect(answer.status).toBe(422);
      expect(answer.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(answer.body).toEqual({
        type: 'about:blank',
        title: 'UNPROCESSABLE_ENTITY',
        status: 422,
        detail: 'El pedido ya fue cancelado',
        traceId: 'trace-7807',
      });
    });

    it('leaves the rest of the table to Nova, and the 5xx rule with it', async () => {
      const answer = await get<Problem>(`${url}/orders/down`);

      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({
        title: 'SERVICE_UNAVAILABLE',
        detail: statusToErrorMessage(503),
      });
      expect(JSON.stringify(answer.body)).not.toContain('payments');
    });
  });
});
