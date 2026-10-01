import { DomainErrorType } from './error-type';
import { Layer } from './layer';
import { NovaError } from './nova-error';

/**
 * Lo que acepta cada fábrica de {@link DomainError}.
 */
export type DomainErrorOptions = {
  /**
   * El código propio, como `ORDER_NOT_FOUND`. Sin él, el cliente ve el del
   * status.
   */
  readonly code?: string;
  /** La excepción que lo originó. Va al log y nunca al cliente. */
  readonly cause?: unknown;
};

/**
 * Un error de negocio: esperado, se registra en `warn` y sin stack.
 *
 * @example
 * throw DomainError.notFound('Pedido no encontrado', {
 *   code: 'ORDER_NOT_FOUND',
 * });
 */
export class DomainError extends NovaError<DomainErrorType> {
  constructor(
    type: DomainErrorType,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super({ ...options, layer: Layer.DOMAIN, type, message });
  }

  /** 404: el recurso de negocio no existe. */
  static notFound(message: string, options?: DomainErrorOptions): DomainError {
    return new DomainError(DomainErrorType.NOT_FOUND, message, options);
  }

  /** 409: el estado del recurso no admite la operación. */
  static conflict(message: string, options?: DomainErrorOptions): DomainError {
    return new DomainError(DomainErrorType.CONFLICT, message, options);
  }

  /** 422: una regla de negocio dijo que no. */
  static ruleViolation(
    message: string,
    options?: DomainErrorOptions,
  ): DomainError {
    return new DomainError(DomainErrorType.RULE_VIOLATION, message, options);
  }
}
