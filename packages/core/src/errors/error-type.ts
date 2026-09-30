// Un tipo enumerado por capa, y no un texto libre: sin tipos, cada servicio
// inventa su nombre y el tablero vuelve a agrupar por cadenas que no coinciden.
// Cada valor es una fila de la tabla de ADR-031; el status HTTP que le toca lo
// decide `ErrorStatusMapper`, no quien lanza.

/** Los tipos de {@link DomainError}. */
export enum DomainErrorType {
  /** 404: el recurso de negocio no existe. */
  NOT_FOUND = 'NOT_FOUND',
  /**
   * 409: el estado del recurso no admite la operación, como confirmar un
   * pedido cancelado.
   */
  CONFLICT = 'CONFLICT',
  /** 422: una regla de negocio dijo que no. */
  RULE_VIOLATION = 'RULE_VIOLATION',
}

/** Los tipos de {@link ApplicationError}. */
export enum ApplicationErrorType {
  /** 400: la entrada no es válida; lleva los errores por campo. */
  INVALID_INPUT = 'INVALID_INPUT',
  /**
   * 409: la operación choca con otra en curso, como una clave de idempotencia
   * en uso.
   */
  CONFLICT = 'CONFLICT',
  /** 422: la entrada es válida pero no se puede procesar. */
  UNPROCESSABLE = 'UNPROCESSABLE',
  /** 401: falta la identidad o no es válida. */
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  /** 403: la identidad no tiene permiso. */
  FORBIDDEN = 'FORBIDDEN',
  /** 429: se superó un límite. */
  RATE_LIMITED = 'RATE_LIMITED',
}

/** Los tipos de {@link InfrastructureError}. */
export enum InfrastructureErrorType {
  /** 503: una dependencia no está disponible. */
  UNAVAILABLE = 'UNAVAILABLE',
  /** 504: una dependencia no respondió a tiempo. */
  TIMEOUT = 'TIMEOUT',
  /** 502: una dependencia respondió algo inválido. */
  BAD_GATEWAY = 'BAD_GATEWAY',
}

/** Los tipos de {@link PlatformError}. */
export enum PlatformErrorType {
  /** 500: un defecto o una falla del propio servicio. */
  INTERNAL = 'INTERNAL',
}

/** Cualquiera de los tipos de las cuatro capas. */
export type ErrorType =
  | DomainErrorType
  | ApplicationErrorType
  | InfrastructureErrorType
  | PlatformErrorType;
