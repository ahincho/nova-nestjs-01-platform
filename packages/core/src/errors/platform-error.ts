import { PlatformErrorType } from './error-type';
import { Layer } from './layer';
import { NovaError } from './nova-error';

/**
 * Lo que acepta la fábrica de {@link PlatformError}.
 */
export type PlatformErrorOptions = {
  /** El código propio. El catálogo de Nova no lo muestra en un 5xx. */
  readonly code?: string;
  /** La excepción que lo originó. Va al log y nunca al cliente. */
  readonly cause?: unknown;
};

/**
 * Un defecto o una falla del propio servicio durante una petición. Es un
 * incidente: se registra en `error`, con la causa completa, y el cliente recibe
 * sólo el mensaje genérico.
 *
 * Es para lo que pasa **durante una petición**. Un error de configuración al
 * arrancar no se responde: la aplicación no arranca.
 *
 * Cualquier excepción que no sea de Nova ni del framework llega al cliente como
 * uno de éstos, así que lanzarlo a mano sólo hace falta para ponerle un mensaje
 * de log o un código propio.
 */
export class PlatformError extends NovaError<PlatformErrorType> {
  constructor(
    type: PlatformErrorType,
    message: string,
    options: PlatformErrorOptions = {},
  ) {
    super({ ...options, layer: Layer.PLATFORM, type, message });
  }

  /** 500: un defecto o una falla del propio servicio. */
  static internal(
    message: string,
    options?: PlatformErrorOptions,
  ): PlatformError {
    return new PlatformError(PlatformErrorType.INTERNAL, message, options);
  }
}
