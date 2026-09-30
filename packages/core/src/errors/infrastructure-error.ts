import { InfrastructureErrorType } from './error-type';
import { Layer } from './layer';
import { NovaError } from './nova-error';

/**
 * Lo que acepta cada fábrica de {@link InfrastructureError}.
 */
export type InfrastructureErrorOptions = {
  /**
   * Para el log. El cliente nunca lo ve: un 5xx contesta el mensaje genérico.
   * Sin él, se arma uno con el tipo y el proveedor.
   */
  readonly message?: string;
  /** El código propio. El catálogo de Nova no lo muestra en un 5xx. */
  readonly code?: string;
  /** La excepción que lo originó: el timeout, el rechazo de la conexión. */
  readonly cause?: unknown;
};

/**
 * Lo que aceptan las fábricas de lo que se puede reintentar: además, cuánto
 * esperar.
 */
export type RetryableInfrastructureErrorOptions = InfrastructureErrorOptions & {
  /** Segundos. Sale como la cabecera `Retry-After`. */
  readonly retryAfter?: number;
};

// Sólo para el log, por eso en inglés como el resto de los mensajes que
// escribe la plataforma.
const DEFAULT_MESSAGES: Readonly<Record<InfrastructureErrorType, string>> = {
  [InfrastructureErrorType.UNAVAILABLE]: 'is unavailable',
  [InfrastructureErrorType.TIMEOUT]: 'did not respond in time',
  [InfrastructureErrorType.BAD_GATEWAY]: 'answered with an invalid response',
};

function defaultMessage(
  type: InfrastructureErrorType,
  upstream: string | undefined,
): string {
  const subject =
    upstream === undefined ? 'An upstream' : `Upstream ${upstream}`;
  return `${subject} ${DEFAULT_MESSAGES[type]}`;
}

/**
 * Una dependencia falló: no está, no contestó a tiempo o contestó algo
 * inválido. Es un incidente: se registra en `error`, con la causa completa.
 *
 * El nombre del proveedor va **sólo al log**, en el campo `upstream`. El cuerpo
 * lleva el código genérico del status -`SERVICE_UNAVAILABLE`,
 * `GATEWAY_TIMEOUT`, `BAD_GATEWAY`-, que alcanza para saber si conviene
 * reintentar sin conocer la topología.
 *
 * @example
 * throw InfrastructureError.timeout('academic-orchestrator', { cause });
 */
export class InfrastructureError extends NovaError<InfrastructureErrorType> {
  /**
   * @param upstream - la dependencia que falló. Ausente sólo cuando la
   *   plataforma traduce un fallo que no la nombra.
   */
  constructor(
    type: InfrastructureErrorType,
    upstream: string | undefined,
    options: RetryableInfrastructureErrorOptions = {},
  ) {
    super({
      ...options,
      layer: Layer.INFRASTRUCTURE,
      type,
      upstream,
      message: options.message ?? defaultMessage(type, upstream),
    });
  }

  /**
   * 503: la dependencia no está disponible. Con `retryAfter`, cuándo volver a
   * intentar.
   */
  static unavailable(
    upstream: string,
    options?: RetryableInfrastructureErrorOptions,
  ): InfrastructureError {
    return new InfrastructureError(
      InfrastructureErrorType.UNAVAILABLE,
      upstream,
      options,
    );
  }

  /** 504: la dependencia no respondió a tiempo. */
  static timeout(
    upstream: string,
    options?: InfrastructureErrorOptions,
  ): InfrastructureError {
    return new InfrastructureError(
      InfrastructureErrorType.TIMEOUT,
      upstream,
      options,
    );
  }

  /** 502: la dependencia respondió algo inválido. */
  static badGateway(
    upstream: string,
    options?: InfrastructureErrorOptions,
  ): InfrastructureError {
    return new InfrastructureError(
      InfrastructureErrorType.BAD_GATEWAY,
      upstream,
      options,
    );
  }
}
