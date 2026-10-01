import {
  Body,
  Controller,
  Get,
  HttpException,
  Module,
  NotFoundException,
  Param,
  Post,
  type INestApplication,
  type LoggerService,
} from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString } from 'class-validator';
import { fetch } from 'undici';
import {
  errorCodeFor,
  type ApiErrorCatalog,
  type ApiFailure,
  type ApiStandard,
  type ApiStandardDocs,
  type ApiWire,
} from '../api-standard';
import { bootstrap } from '../bootstrap';
import type { ErrorCatalog } from '../errors';
import { NovaModule } from '../nova.module';
import { ApiEnvelope, ApiErrors } from '../openapi';

/**
 * El estándar de una organización que no usa el sobre de Nova: el éxito va
 * dentro de `{ ok, result }` y los errores salen en RFC 7807.
 *
 * Es deliberadamente distinto en todo lo que el puerto deja cambiar -forma,
 * catálogo, `Content-Type`-, para que cualquier cosa que el núcleo siga
 * haciendo con la forma de Nova se vea acá.
 */
/** El mensaje con que la organización contesta lo que no puede explicar. */
const ORG_INTERNAL_MESSAGE = 'Algo falló de nuestro lado';

const CATALOG: ApiErrorCatalog = {
  validation: 'INVALID_INPUT',
  byStatus: { 404: 'NOT_FOUND', 502: 'BAD_GATEWAY' },
  request: 'CLIENT_ERROR',
  internal: 'SERVER_ERROR',
};

class OrgStandard implements ApiStandard {
  /**
   * Cómo nombra la organización sus fallos (ADR-031). Recibe el error ya
   * saneado: por encima de 500 no trae ni su código ni su mensaje.
   */
  readonly errorCatalog: ErrorCatalog = {
    describe: (error, status) => ({
      code: error.code ?? errorCodeFor(CATALOG, status, error.kind),
      message: error.message ?? ORG_INTERNAL_MESSAGE,
    }),
  };

  readonly openapi: ApiStandardDocs = {
    components: {
      Problem: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          status: { type: 'number' },
          detail: { type: 'string' },
        },
      },
    },
    success: (payload) => ({
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, result: payload },
      },
    }),
    failure: (status) => ({
      contentType: 'application/problem+json',
      description: errorCodeFor(
        CATALOG,
        status,
        status >= 500 ? 'internal' : 'request',
      ),
      schema: { $ref: '#/components/schemas/Problem' },
    }),
  };

  success(payload: unknown): ApiWire {
    return { body: { ok: true, result: payload } };
  }

  failure(failure: ApiFailure): ApiWire {
    const title = errorCodeFor(CATALOG, failure.status, failure.kind);
    const [first] = failure.errors;

    return {
      contentType: 'application/problem+json',
      body: {
        type: 'about:blank',
        title,
        status: failure.status,
        detail: first?.message,
        code: first?.code ?? title,
        traceId: failure.traceId,
        ...(failure.kind === 'validation'
          ? {
              errors: failure.errors.map((error) => ({
                field: error.field,
                detail: error.message,
              })),
            }
          : {}),
      },
    };
  }

  owns(payload: unknown): boolean {
    return typeof payload === 'object' && payload !== null && 'ok' in payload;
  }
}

class CourseResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;
}

class CreateCourseRequest {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsInt()
  credits: number;
}

@Controller('courses')
class CoursesController {
  @Get(':id')
  @ApiEnvelope(CourseResponse)
  @ApiErrors(404, 502)
  findOne(@Param('id') id: string): CourseResponse {
    if (id === 'missing') {
      throw new NotFoundException('Curso no encontrado', {
        errorCode: 'COURSE_NOT_FOUND',
      });
    }
    if (id === 'broken') {
      throw new Error('connect ECONNREFUSED 10.0.3.14:5432');
    }
    if (id === 'upstream') {
      throw new HttpException('Upstream academic exploded', 502, {
        errorCode: 'ACADEMIC_DOWN',
      });
    }
    return { id, name: 'Cálculo I' };
  }

  @Post()
  create(@Body() request: CreateCourseRequest): CreateCourseRequest {
    return request;
  }
}

@Module({
  imports: [
    NovaModule.forRoot({
      apiStandard: { standard: OrgStandard },
      observability: { logger: false },
    }),
  ],
  controllers: [CoursesController],
})
class OrgModule {}

const silent: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  fatal: () => undefined,
};

type Answer = {
  status: number;
  contentType: string | null;
  text: string;
  body: Record<string, unknown>;
};

// Pasa por `bootstrap()` a propósito: la entrada se valida con el pipe que
// instala el arranque, y el documento lo arma el mismo `setupOpenApi` que en
// producción. Es la prueba de que el estándar reemplazado llega a todos los
// caminos, no sólo a los que se probaron por separado.
describe('a service with a standard of its own', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    app = await bootstrap(OrgModule, {
      port: 0,
      host: '127.0.0.1',
      logger: silent,
      openapi: { title: 'Org', bearerAuth: false },
    });
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  async function call(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Answer> {
    const response = await fetch(`${url}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      text,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  }

  describe('output', () => {
    it('answers a success in the shape of the standard', async () => {
      const answer = await call('/courses/1');

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({
        ok: true,
        result: { id: '1', name: 'Cálculo I' },
      });
    });

    it('answers a failure in the shape and content type of the standard', async () => {
      const answer = await call('/courses/missing', {
        headers: { 'x-request-id': 'trace-abc' },
      });

      expect(answer.status).toBe(404);
      expect(answer.contentType).toMatch(/^application\/problem\+json/);
      expect(answer.body).toEqual({
        type: 'about:blank',
        title: 'NOT_FOUND',
        status: 404,
        detail: 'Curso no encontrado',
        code: 'COURSE_NOT_FOUND',
        traceId: 'trace-abc',
      });
    });

    // La regla del núcleo, vista desde afuera: con un estándar que no es el de
    // Nova, el 5xx sigue sin decir qué falló.
    it('never lets the standard say what failed inside', async () => {
      const answer = await call('/courses/broken');

      expect(answer.status).toBe(500);
      expect(answer.body).toMatchObject({
        title: 'SERVER_ERROR',
        detail: ORG_INTERNAL_MESSAGE,
        code: 'SERVER_ERROR',
      });
      expect(answer.text).not.toContain('ECONNREFUSED');
    });

    // El catálogo puede nombrar un 502; lo que no puede es recibir el código de
    // dominio ni el mensaje que la excepción traía.
    it('names a 5xx by the catalog and keeps its detail out', async () => {
      const answer = await call('/courses/upstream');

      expect(answer.status).toBe(502);
      expect(answer.body).toMatchObject({
        title: 'BAD_GATEWAY',
        code: 'BAD_GATEWAY',
        detail: ORG_INTERNAL_MESSAGE,
      });
      expect(answer.text).not.toContain('ACADEMIC_DOWN');
      expect(answer.text).not.toContain('exploded');
    });

    // Las sondas quedan fuera de cualquier estándar: el balanceador revisa la
    // forma del cuerpo, y esa forma no es de la organización.
    it('leaves the health probes out of the standard', async () => {
      const answer = await call('/health/live');

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ status: 'ok' });
      expect(answer.body).not.toHaveProperty('result');
    });
  });

  describe('input', () => {
    it('answers a success with the created resource', async () => {
      const answer = await call('/courses', {
        method: 'POST',
        body: { name: 'Cálculo I', credits: 4 },
      });

      expect(answer.status).toBe(201);
      expect(answer.body).toEqual({
        ok: true,
        result: { name: 'Cálculo I', credits: 4 },
      });
    });

    it('rejects an invalid input in the words of the standard', async () => {
      const answer = await call('/courses', {
        method: 'POST',
        body: { name: '', credits: 'four' },
      });

      expect(answer.status).toBe(400);
      expect(answer.contentType).toMatch(/^application\/problem\+json/);
      expect(answer.body).toMatchObject({
        title: 'INVALID_INPUT',
        code: 'INVALID_INPUT',
      });
      expect(answer.body['errors']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'name' }),
          expect.objectContaining({ field: 'credits' }),
        ]),
      );
    });

    // La regla de rechazar lo que ningún DTO declara es del núcleo; el
    // estándar sólo decide cómo se cuenta.
    it('still rejects a property no DTO declares', async () => {
      const answer = await call('/courses', {
        method: 'POST',
        body: { name: 'Cálculo I', credits: 4, discount: 100 },
      });

      expect(answer.status).toBe(400);
      expect(answer.body['errors']).toEqual([
        expect.objectContaining({ field: 'discount' }),
      ]);
    });
  });

  describe('documentation', () => {
    let document: {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
      components: { schemas: Record<string, unknown> };
    };

    beforeAll(async () => {
      document = (await call('/docs/json')).body as typeof document;
    });

    it('documents the success the standard answers', () => {
      expect(
        document.paths['/courses/{id}']?.['get']?.responses['200'],
      ).toEqual({
        description: '',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                result: { $ref: '#/components/schemas/CourseResponse' },
              },
            },
          },
        },
      });
    });

    it('documents a failure as the standard answers it', () => {
      expect(
        document.paths['/courses/{id}']?.['get']?.responses['404'],
      ).toEqual({
        description: 'NOT_FOUND',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        },
      });
    });

    it('does not describe an envelope the service never sends', () => {
      expect(document.components.schemas).toHaveProperty('Problem');
      expect(document.components.schemas).not.toHaveProperty(
        'ApiEnvelopeSchema',
      );
    });
  });
});
