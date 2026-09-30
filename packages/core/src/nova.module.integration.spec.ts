import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import {
  ApplicationError,
  DomainError,
  InfrastructureError,
  type ErrorCatalog,
} from './errors';
import { NovaModule, type NovaModuleOptions } from './nova.module';

type Answer = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: {
    success: boolean;
    status: number;
    errors: { code: string; message: string; field: string | null }[];
    metadata?: { traceId: string | null };
  };
};

@Controller('orders')
class OrdersController {
  @Get('missing')
  missing(): never {
    throw DomainError.notFound('Pedido no encontrado', {
      code: 'ORDER_NOT_FOUND',
    });
  }

  // El error nace después de un await: el contexto de la petición tiene que
  // seguir ahí para que tome su traceId.
  @Get('slow')
  async slow(): Promise<never> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    throw InfrastructureError.timeout('academic-orchestrator');
  }

  @Get('busy')
  busy(): never {
    throw ApplicationError.rateLimited('Demasiadas solicitudes', {
      retryAfter: 30,
    });
  }

  @Get('legacy')
  legacy(): never {
    throw new NotFoundException('Curso no encontrado');
  }
}

/** Un GET con `node:http`, que ningún test reemplaza como pasa con `fetch`. */
function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    httpGet(url, { headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: JSON.parse(text) as Answer['body'],
        });
      });
    }).on('error', reject);
  });
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
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
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

    it('keeps the traceId of an error born after an await', async () => {
      const answer = await get(`${url}/orders/slow`);

      expect(answer.status).toBe(504);
      expect(answer.body.errors[0]?.code).toBe('GATEWAY_TIMEOUT');
      expect(answer.body.metadata?.traceId).toBe(
        answer.headers['x-request-id'],
      );
      expect(JSON.stringify(answer.body)).not.toContain('academic');
    });

    it('sends Retry-After', async () => {
      const answer = await get(`${url}/orders/busy`);

      expect(answer.status).toBe(429);
      expect(answer.headers['retry-after']).toBe('30');
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
});
