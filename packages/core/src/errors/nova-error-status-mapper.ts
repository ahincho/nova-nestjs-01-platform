import {
  ApplicationErrorType,
  DomainErrorType,
  InfrastructureErrorType,
  PlatformErrorType,
} from './error-type';
import { Layer } from './layer';
import type { NovaError } from './nova-error';
import type { ErrorStatusMapper } from './ports';

// La tabla de ADR-031, fila por fila. `domain` y `application` son 4xx porque
// son esperados; `infrastructure` y `platform` son 5xx porque son incidentes.
const STATUS_BY_LAYER: {
  readonly [L in Layer]: Readonly<Record<string, number>>;
} = {
  [Layer.DOMAIN]: {
    [DomainErrorType.NOT_FOUND]: 404,
    [DomainErrorType.CONFLICT]: 409,
    [DomainErrorType.RULE_VIOLATION]: 422,
  },
  [Layer.APPLICATION]: {
    [ApplicationErrorType.INVALID_INPUT]: 400,
    [ApplicationErrorType.CONFLICT]: 409,
    [ApplicationErrorType.UNPROCESSABLE]: 422,
    [ApplicationErrorType.UNAUTHENTICATED]: 401,
    [ApplicationErrorType.FORBIDDEN]: 403,
    [ApplicationErrorType.RATE_LIMITED]: 429,
  },
  [Layer.INFRASTRUCTURE]: {
    [InfrastructureErrorType.UNAVAILABLE]: 503,
    [InfrastructureErrorType.TIMEOUT]: 504,
    [InfrastructureErrorType.BAD_GATEWAY]: 502,
  },
  [Layer.PLATFORM]: {
    [PlatformErrorType.INTERNAL]: 500,
  },
};

/**
 * El {@link ErrorStatusMapper} de Nova: la tabla de ADR-031.
 *
 * Para cambiar una sola fila, un mapper propio puede consultar el suyo y caer a
 * éste para el resto.
 */
export class NovaErrorStatusMapper implements ErrorStatusMapper {
  statusOf(error: NovaError): number {
    // Un tipo fuera de la tabla sólo puede venir de código sin tipos. Sale como
    // 500 porque es un defecto, y un 500 es lo único que no promete nada.
    return STATUS_BY_LAYER[error.layer][error.type] ?? 500;
  }
}
