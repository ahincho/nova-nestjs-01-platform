import { NovaErrorCatalog } from '../errors/nova-error-catalog';
import { NovaErrorSerializer } from '../errors/nova-error-serializer';
import type { ErrorCatalog } from '../errors/ports';
import { ApiResponses } from './api-responses';
import type {
  ApiFailure,
  ApiStandard,
  ApiStandardDocs,
  ApiWire,
  OpenApiSchema,
} from './api-standard';
import {
  NOVA_ERROR_CATALOG,
  errorCodeFor,
  mergeErrorCatalog,
  type ApiErrorCatalog,
} from './error-code';

/** Nombre del sobre en `components.schemas`. */
export const ENVELOPE_SCHEMA_NAME = 'ApiEnvelopeSchema';

/** Nombre de una entrada de error en `components.schemas`. */
export const ERROR_ITEM_SCHEMA_NAME = 'ApiErrorItemSchema';

/** Nombre de la `metadata` del sobre en `components.schemas`. */
export const METADATA_SCHEMA_NAME = 'ApiMetadataSchema';

export type NovaEnvelopeOptions = {
  /**
   * Códigos que cambian respecto de {@link NOVA_ERROR_CATALOG}. Se suman al
   * catálogo en vez de reemplazarlo: quien quiere nombrar un 409 no tiene que
   * volver a escribir los otros quince.
   *
   * @example
   * new NovaEnvelopeStandard({ codes: { byStatus: { 409: 'ALREADY_EXISTS' } } });
   */
  readonly codes?: Partial<ApiErrorCatalog>;
};

function ref(name: string): OpenApiSchema {
  return { $ref: `#/components/schemas/${name}` };
}

// Los mismos esquemas que `@nestjs/swagger` genera de las clases
// `ApiEnvelopeSchema`, `ApiErrorItemSchema` y `ApiMetadataSchema`, escritos a
// mano para que este módulo no dependa de él. Una prueba compara los dos: si se
// separan, el documento cambiaría según quién lo arme.
const COMPONENTS: Readonly<Record<string, OpenApiSchema>> = {
  [ERROR_ITEM_SCHEMA_NAME]: {
    type: 'object',
    properties: {
      code: { type: 'string', example: 'NOT_FOUND' },
      message: { type: 'string', example: 'Course not found' },
      field: { type: 'string', nullable: true, example: null },
    },
    required: ['code', 'message', 'field'],
  },
  [METADATA_SCHEMA_NAME]: {
    type: 'object',
    properties: {
      traceId: {
        type: 'string',
        nullable: true,
        example: '3f2b8c1e-5d4a-4f6b-9a7c-2e1d0b9f8a6c',
      },
    },
    required: ['traceId'],
  },
  [ENVELOPE_SCHEMA_NAME]: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      status: { type: 'number', example: 200 },
      data: { type: 'object', nullable: true },
      errors: { type: 'array', items: ref(ERROR_ITEM_SCHEMA_NAME) },
      metadata: {
        description: 'Presente en las respuestas de error.',
        allOf: [ref(METADATA_SCHEMA_NAME)],
      },
    },
    required: ['success', 'status', 'data', 'errors'],
  },
};

function envelopeDocs(catalog: ApiErrorCatalog): ApiStandardDocs {
  return {
    components: COMPONENTS,

    success: (payload) => ({
      schema: {
        allOf: [
          ref(ENVELOPE_SCHEMA_NAME),
          {
            properties: {
              // Una lista viaja como lista; un objeto puede faltar, y el sobre
              // lo contesta como `data: null`.
              data:
                payload['type'] === 'array'
                  ? payload
                  : { ...payload, nullable: true },
            },
          },
        ],
      },
    }),

    failure: (status) => ({
      description: errorCodeFor(
        catalog,
        status,
        status >= 500 ? 'internal' : 'request',
      ),
      schema: {
        allOf: [
          ref(ENVELOPE_SCHEMA_NAME),
          {
            // Un error siempre trae `metadata`, con el `traceId` que se cita al
            // reportarlo; el sobre base la declara opcional por los éxitos.
            required: ['metadata'],
            properties: {
              success: { type: 'boolean', example: false },
              status: { type: 'number', example: status },
              data: { nullable: true, example: null },
            },
          },
        ],
      },
    }),
  };
}

/**
 * El estándar de API de Nova: el sobre `{ success, status, data, errors }`.
 *
 * Es la implementación que se registra cuando nadie declara otra, y la que
 * contesta igual que antes de que el estándar se pudiera reemplazar. Un error
 * suma `metadata.traceId` al cuerpo y, cuando dice cuánto esperar, la cabecera
 * `Retry-After` (ADR-031); un éxito no cambia.
 *
 * @example
 * NovaModule.forRoot({
 *   apiStandard: {
 *     standard: new NovaEnvelopeStandard({
 *       codes: { byStatus: { 409: 'ALREADY_EXISTS' } },
 *     }),
 *   },
 * });
 */
export class NovaEnvelopeStandard implements ApiStandard {
  /** El catálogo con el que nombra los fallos que no traen código propio. */
  readonly catalog: ApiErrorCatalog;

  /**
   * El mismo catálogo, como puerto de ADR-031: es el que usa el filtro salvo que
   * el servicio declare `errors.catalog`.
   */
  readonly errorCatalog: ErrorCatalog;

  readonly openapi: ApiStandardDocs;

  private readonly serializer = new NovaErrorSerializer();

  constructor(options: NovaEnvelopeOptions = {}) {
    this.catalog = mergeErrorCatalog(NOVA_ERROR_CATALOG, options.codes);
    this.errorCatalog = new NovaErrorCatalog(
      options.codes === undefined ? {} : { codes: options.codes },
    );
    this.openapi = envelopeDocs(this.catalog);
  }

  success(payload: unknown, status: number): ApiWire {
    return { body: ApiResponses.ok(payload, status) };
  }

  failure(failure: ApiFailure): ApiWire {
    return this.serializer.serialize({
      ...failure,
      // Lo que no trae código lo nombra el catálogo de este estándar y no el de
      // Nova, para que `codes` valga también cuando alguien llama a mano.
      errors: failure.errors.map((error) => ({
        ...error,
        code:
          error.code ??
          errorCodeFor(this.catalog, failure.status, failure.kind),
      })),
    });
  }

  owns(payload: unknown): boolean {
    return ApiResponses.isApiResponse(payload);
  }
}
