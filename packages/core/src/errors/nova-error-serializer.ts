import { errorItem } from '../api-standard/api-error';
import type { ApiFailure, ApiWire } from '../api-standard/api-standard';
import { ApiResponses } from '../api-standard/api-responses';
import { NOVA_ERROR_CATALOG, errorCodeFor } from '../api-standard/error-code';
import type { ErrorSerializer } from './ports';

/**
 * El {@link ErrorSerializer} de Nova: el sobre de siempre, con
 * `metadata.traceId`, y la cabecera `Retry-After` cuando el error dice cuánto
 * esperar.
 *
 * Es también lo que contesta `NovaEnvelopeStandard` para un fallo, así que el
 * sobre de Nova se escribe en un solo lugar.
 *
 * @example
 * // ApplicationError.rateLimited('Demasiadas solicitudes', { retryAfter: 30 })
 * // Retry-After: 30
 * {
 *   "success": false,
 *   "status": 429,
 *   "data": null,
 *   "errors": [
 *     {
 *       "code": "TOO_MANY_REQUESTS",
 *       "message": "Demasiadas solicitudes",
 *       "field": null
 *     }
 *   ],
 *   "metadata": { "traceId": "b3f1c2d4-..." }
 * }
 */
export class NovaErrorSerializer implements ErrorSerializer {
  serialize(failure: ApiFailure): ApiWire {
    const envelope = ApiResponses.error(
      failure.status,
      ...failure.errors.map((error) =>
        errorItem(
          // El filtro global siempre trae el código. Sin él -alguien llamó al
          // serializador a mano- se usa el del catálogo de Nova.
          error.code ??
            errorCodeFor(NOVA_ERROR_CATALOG, failure.status, failure.kind),
          error.message,
          error.field,
        ),
      ),
    );

    return {
      body: ApiResponses.withMetadata(envelope, {
        traceId: failure.traceId ?? null,
      }),
      ...(failure.retryAfter === undefined
        ? {}
        : { headers: { 'Retry-After': String(failure.retryAfter) } }),
    };
  }
}
