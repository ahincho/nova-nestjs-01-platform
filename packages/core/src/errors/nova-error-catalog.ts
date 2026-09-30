import { statusToErrorCode } from '../api-standard/error-code';
import type { LayeredError } from './nova-error';
import type { ErrorCatalog, ErrorDescription } from './ports';

/**
 * El mensaje de todo 5xx cuando nadie configura otro.
 */
export const DEFAULT_INTERNAL_ERROR_MESSAGE = 'Internal server error';

export type NovaErrorCatalogOptions = {
  /**
   * El mensaje de todo 5xx. Llega al cliente tal cual, así que nunca lleva la
   * falla de fondo. Por defecto {@link DEFAULT_INTERNAL_ERROR_MESSAGE}.
   */
  readonly internalErrorMessage?: string;
};

/**
 * El {@link ErrorCatalog} de Nova.
 *
 * En un 4xx, el código propio del error si lo trae y si no el del catálogo de la
 * plataforma, con el mensaje del error. En un 5xx, siempre el código del
 * catálogo y el mensaje genérico: el código propio, el mensaje y el proveedor
 * cuentan qué falló por dentro, y eso va al log.
 */
export class NovaErrorCatalog implements ErrorCatalog {
  private readonly internalErrorMessage: string;

  constructor(options: NovaErrorCatalogOptions = {}) {
    this.internalErrorMessage =
      options.internalErrorMessage ?? DEFAULT_INTERNAL_ERROR_MESSAGE;
  }

  describe(error: LayeredError, status: number): ErrorDescription {
    if (status >= 500) {
      return {
        code: statusToErrorCode(status),
        message: this.internalErrorMessage,
      };
    }

    return {
      code: error.code ?? statusToErrorCode(status),
      message: error.message,
    };
  }
}
