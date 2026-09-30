import { errorItem, type ApiErrorItem } from '../api-standard/api-error';
import { ApiResponses } from '../api-standard/api-responses';
import type { LayeredError } from './nova-error';
import type { ErrorReply, ErrorSerializer, SerializedError } from './ports';

/**
 * El {@link ErrorSerializer} de Nova: el sobre de siempre, con
 * `metadata.traceId`, y la cabecera `Retry-After` cuando el error dice cuánto
 * esperar.
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
  serialize(error: LayeredError, reply: ErrorReply): SerializedError {
    const envelope = ApiResponses.error(
      reply.status,
      ...entriesOf(error, reply),
    );

    return {
      headers:
        error.retryAfter === undefined
          ? {}
          : { 'Retry-After': String(error.retryAfter) },
      body: ApiResponses.withMetadata(envelope, {
        traceId: reply.traceId ?? null,
      }),
    };
  }
}

function entriesOf(error: LayeredError, reply: ErrorReply): ApiErrorItem[] {
  // Una entrada por campo, para que el formulario sepa qué input marcar. Sólo en
  // un 4xx: un 5xx lleva el código genérico y nada más, aunque un mapper propio
  // haya llevado ahí un error de entrada.
  if (reply.status < 500 && error.fieldErrors.length > 0) {
    return error.fieldErrors.map((fieldError) =>
      errorItem(
        fieldError.code ?? reply.code,
        fieldError.message,
        fieldError.field,
      ),
    );
  }

  return [errorItem(reply.code, reply.message)];
}
