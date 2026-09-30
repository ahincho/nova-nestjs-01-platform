/**
 * El código de un 5xx que la tabla no nombra.
 */
export const INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';

/**
 * Code used for a 4xx this table does not name.
 */
export const DEFAULT_ERROR_CODE = 'REQUEST_ERROR';

// El catálogo de la plataforma de ADR-031, el mismo en los tres stacks. Los
// tres 5xx con nombre propio son los que le dicen al cliente si conviene
// reintentar -un 503 o un 504 sí, un 500 no- sin contarle la topología: el
// código es el del status, y el proveedor que falló va sólo al log.
const STATUS_ERROR_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  410: 'GONE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: INTERNAL_ERROR_CODE,
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

/**
 * El código estable por el que ramifica el cliente, a partir del status HTTP.
 *
 * El cliente decide por `code` y no por `status` porque el código sobrevive a un
 * cambio de transporte. Un 4xx que la tabla no nombra lleva
 * {@link DEFAULT_ERROR_CODE}, y un 5xx, {@link INTERNAL_ERROR_CODE}.
 */
export function statusToErrorCode(status: number): string {
  const named = STATUS_ERROR_CODES[status];

  if (named !== undefined) {
    return named;
  }

  return status >= 500 ? INTERNAL_ERROR_CODE : DEFAULT_ERROR_CODE;
}
