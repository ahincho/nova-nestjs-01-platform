import {
  NOVA_ERROR_CATALOG,
  errorCodeFor,
  mergeErrorCatalog,
  type ApiErrorCatalog,
} from '../api-standard/error-code';
import {
  DEFAULT_INTERNAL_ERROR_MESSAGE,
  statusToErrorMessage,
} from '../api-standard/error-message';
import type { ErrorCatalog, ErrorDescription, SanitizedError } from './ports';

// El mensaje de un 500 y de un 5xx sin fila es una constante de la plataforma,
// pero se importa de este módulo: es donde vive el catálogo que la usa.
export { DEFAULT_INTERNAL_ERROR_MESSAGE };

export type NovaErrorCatalogOptions = {
  /**
   * Códigos que cambian respecto de {@link NOVA_ERROR_CATALOG}. Se suman al
   * catálogo en vez de reemplazarlo.
   *
   * @example
   * new NovaErrorCatalog({ codes: { byStatus: { 409: 'ALREADY_EXISTS' } } });
   */
  readonly codes?: Partial<ApiErrorCatalog>;

  /**
   * El mensaje de todo 5xx. Llega al cliente tal cual, así que nunca lleva la
   * falla de fondo. Sin él, cada 5xx lleva el mensaje de su status: el 502
   * dice que una dependencia respondió con un error, el 504 que no respondió a
   * tiempo.
   */
  readonly internalErrorMessage?: string;
};

/**
 * El {@link ErrorCatalog} de Nova (ADR-031): el mismo en los tres stacks.
 *
 * En un 4xx, el código propio del error si lo trae y si no el del catálogo de
 * la plataforma, con el mensaje propio si lo trae y si no el genérico de su
 * status. En un 5xx, siempre el código del catálogo y el mensaje genérico de su
 * status: el código propio, el mensaje y el proveedor cuentan qué falló por
 * dentro, y eso va al log.
 *
 * Los mensajes genéricos van en español (ADR-031, pregunta abierta 2). Una
 * organización que necesite otros escribe su propio {@link ErrorCatalog}.
 */
export class NovaErrorCatalog implements ErrorCatalog {
  private readonly codes: ApiErrorCatalog;
  private readonly internalErrorMessage: string | undefined;

  constructor(options: NovaErrorCatalogOptions = {}) {
    this.codes = mergeErrorCatalog(NOVA_ERROR_CATALOG, options.codes);
    this.internalErrorMessage = options.internalErrorMessage;
  }

  describe(error: SanitizedError, status: number): ErrorDescription {
    if (status >= 500) {
      return {
        code: errorCodeFor(this.codes, status, 'internal'),
        message: this.internalErrorMessage ?? statusToErrorMessage(status),
      };
    }

    return {
      code: error.code ?? errorCodeFor(this.codes, status, error.kind),
      message: error.message ?? statusToErrorMessage(status),
    };
  }
}
