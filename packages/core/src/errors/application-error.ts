import { ApplicationErrorType } from './error-type';
import { Layer } from './layer';
import { NovaError, type FieldError } from './nova-error';

/**
 * Lo que acepta cada fábrica de {@link ApplicationError}.
 */
export type ApplicationErrorOptions = {
  /** El código propio. Sin él, el cliente ve el del status. */
  readonly code?: string;
  /** La excepción que lo originó. Va al log y nunca al cliente. */
  readonly cause?: unknown;
};

/**
 * Lo que aceptan las fábricas de lo que se puede reintentar: además, cuánto
 * esperar.
 */
export type RetryableErrorOptions = ApplicationErrorOptions & {
  /** Segundos. Sale como la cabecera `Retry-After`. */
  readonly retryAfter?: number;
};

/**
 * Lo que acepta el constructor, que es la suma de todo lo anterior.
 */
export type ApplicationErrorInit = RetryableErrorOptions & {
  readonly fieldErrors?: readonly FieldError[];
};

/**
 * Un error de la operación que se pidió: la entrada, la identidad o un límite.
 * Esperado, se registra en `warn` y sin stack.
 *
 * @example
 * throw ApplicationError.invalidInput('La inscripción no es válida', [
 *   { field: 'periodId', message: 'Debe ser un entero' },
 * ]);
 */
export class ApplicationError extends NovaError<ApplicationErrorType> {
  constructor(
    type: ApplicationErrorType,
    message: string,
    options: ApplicationErrorInit = {},
  ) {
    super({ ...options, layer: Layer.APPLICATION, type, message });
  }

  /**
   * 400: la entrada no es válida. Cada campo que falló viaja como su propia
   * entrada del sobre.
   */
  static invalidInput(
    message: string,
    fieldErrors: readonly FieldError[] = [],
    options: ApplicationErrorOptions = {},
  ): ApplicationError {
    return new ApplicationError(ApplicationErrorType.INVALID_INPUT, message, {
      ...options,
      fieldErrors,
    });
  }

  /**
   * 409: la operación choca con otra en curso, como una clave de idempotencia
   * en uso. Con `retryAfter`, le dice al cliente cuándo volver a intentar.
   */
  static conflict(
    message: string,
    options?: RetryableErrorOptions,
  ): ApplicationError {
    return new ApplicationError(
      ApplicationErrorType.CONFLICT,
      message,
      options,
    );
  }

  /**
   * 422: la entrada es válida pero no se puede procesar, como una clave de
   * idempotencia reusada con otro contenido.
   */
  static unprocessable(
    message: string,
    options?: ApplicationErrorOptions,
  ): ApplicationError {
    return new ApplicationError(
      ApplicationErrorType.UNPROCESSABLE,
      message,
      options,
    );
  }

  /** 401: falta la identidad o no es válida. */
  static unauthenticated(
    message: string,
    options?: ApplicationErrorOptions,
  ): ApplicationError {
    return new ApplicationError(
      ApplicationErrorType.UNAUTHENTICATED,
      message,
      options,
    );
  }

  /** 403: la identidad no tiene permiso. */
  static forbidden(
    message: string,
    options?: ApplicationErrorOptions,
  ): ApplicationError {
    return new ApplicationError(
      ApplicationErrorType.FORBIDDEN,
      message,
      options,
    );
  }

  /** 429: se superó un límite. Con `retryAfter`, cuándo se libera. */
  static rateLimited(
    message: string,
    options?: RetryableErrorOptions,
  ): ApplicationError {
    return new ApplicationError(
      ApplicationErrorType.RATE_LIMITED,
      message,
      options,
    );
  }
}
