import type { ApiFailureKind } from './api-standard';

/**
 * El código de un 5xx que la tabla no nombra.
 */
export const INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';

/**
 * Code used for a 4xx this table does not name.
 */
export const DEFAULT_ERROR_CODE = 'REQUEST_ERROR';

/**
 * Código de un fallo de validación de la entrada, con una entrada por campo.
 */
export const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';

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
 * Qué código lleva cada fallo que no trae uno propio.
 *
 * Es del estándar y no del núcleo: cómo se **nombra** un fallo es forma, y una
 * organización puede tener la suya. Qué se le **dice** al cliente en un 5xx, en
 * cambio, es contenido, y eso lo decide el núcleo antes de que el catálogo
 * intervenga.
 */
export type ApiErrorCatalog = {
  /** Un fallo de validación de la entrada. */
  readonly validation: string;

  /**
   * Por status HTTP. Lo que no esté acá cae en {@link ApiErrorCatalog.request}
   * o en {@link ApiErrorCatalog.internal}.
   */
  readonly byStatus: Readonly<Record<number, string>>;

  /** Un 4xx que `byStatus` no nombra. */
  readonly request: string;

  /** Un 5xx que `byStatus` no nombra. */
  readonly internal: string;
};

/**
 * El catálogo de Nova (ADR-031): el mismo en los tres stacks.
 *
 * Nombra los cuatro 5xx de la plataforma -500, 502, 503 y 504-, que le dicen al
 * cliente si conviene reintentar sin contarle la topología: el status ya viaja
 * en la línea de estado, así que el código no revela nada que no sepa, y el
 * proveedor que falló va sólo al log. Cualquier otro 5xx cae en
 * {@link INTERNAL_ERROR_CODE}, y cualquier otro 4xx en {@link DEFAULT_ERROR_CODE}.
 * Un catálogo propio puede nombrar otros.
 */
export const NOVA_ERROR_CATALOG: ApiErrorCatalog = {
  validation: VALIDATION_ERROR_CODE,
  byStatus: STATUS_ERROR_CODES,
  request: DEFAULT_ERROR_CODE,
  internal: INTERNAL_ERROR_CODE,
};

/**
 * Suma los códigos que cambian a un catálogo, en vez de reemplazarlo: quien
 * quiere nombrar un 409 no tiene que volver a escribir los otros quince.
 */
export function mergeErrorCatalog(
  base: ApiErrorCatalog,
  codes: Partial<ApiErrorCatalog> = {},
): ApiErrorCatalog {
  return {
    validation: codes.validation ?? base.validation,
    byStatus: { ...base.byStatus, ...codes.byStatus },
    request: codes.request ?? base.request,
    internal: codes.internal ?? base.internal,
  };
}

/**
 * El código que un catálogo le da a un fallo.
 */
export function errorCodeFor(
  catalog: ApiErrorCatalog,
  status: number,
  kind: ApiFailureKind,
): string {
  if (kind === 'validation') {
    return catalog.validation;
  }
  return (
    catalog.byStatus[status] ??
    (status >= 500 ? catalog.internal : catalog.request)
  );
}

/**
 * El código estable por el que ramifica el cliente, a partir del status HTTP y
 * con {@link NOVA_ERROR_CATALOG}.
 *
 * El cliente decide por `code` y no por `status` porque el código sobrevive a un
 * cambio de transporte. Un 4xx que la tabla no nombra lleva
 * {@link DEFAULT_ERROR_CODE}, y un 5xx, {@link INTERNAL_ERROR_CODE}.
 */
export function statusToErrorCode(status: number): string {
  return errorCodeFor(
    NOVA_ERROR_CATALOG,
    status,
    status >= 500 ? 'internal' : 'request',
  );
}
