import { currentRequestId } from '../observability/request-context.storage';
import type { ErrorType } from './error-type';
import type { Layer } from './layer';

/**
 * Un campo de la entrada que no pasó, en un `INVALID_INPUT`.
 */
export type FieldError = {
  /** El campo, con ruta punteada si está anidado: `address.zipCode`. */
  readonly field: string;
  /** Qué tiene de malo, para la persona. */
  readonly message: string;
  /**
   * Opcional. Sin él, la entrada del campo lleva el código del error: con el
   * catálogo de Nova, `BAD_REQUEST`.
   */
  readonly code?: string;
};

/**
 * Lo que los puertos leen de un error: su clasificación y lo que se puede
 * mostrar de él.
 *
 * Un {@link NovaError} lo cumple entero. Es un tipo aparte porque también pasan
 * por los puertos las excepciones propias del framework, que ADR-031 lee según
 * su status y que no siempre tienen un tipo de Nova: un 405 es de `application`
 * y ninguna fila de la tabla lo nombra.
 */
export interface LayeredError {
  readonly layer: Layer;
  /**
   * Ausente sólo en una excepción del framework cuyo status no tiene fila en la
   * tabla.
   */
  readonly type?: ErrorType;
  /**
   * El código propio, como `ORDER_NOT_FOUND`. Con el catálogo de Nova llega al
   * cliente sólo en un 4xx.
   */
  readonly code?: string;
  /**
   * El texto para la persona. Con el catálogo de Nova llega al cliente sólo en
   * un 4xx.
   */
  readonly message: string;
  /** Nunca ausente: vacío cuando el error no es de un campo. */
  readonly fieldErrors: readonly FieldError[];
  /** Segundos enteros que conviene esperar antes de reintentar. */
  readonly retryAfter?: number;
  /** La dependencia que falló. Va al log y nunca al cliente. */
  readonly upstream?: string;
  /** La excepción original. Va al log y nunca al cliente. */
  readonly cause?: unknown;
  /** El id de la petición en la que nació el error, si nació dentro de una. */
  readonly traceId?: string;
}

/**
 * Lo que cada clase de capa le pasa a la base.
 */
export type NovaErrorInit<TType extends ErrorType> = {
  readonly layer: Layer;
  readonly type: TType;
  readonly message: string;
  readonly code?: string;
  readonly fieldErrors?: readonly FieldError[];
  readonly retryAfter?: number;
  readonly upstream?: string;
  readonly cause?: unknown;
};

/**
 * `Retry-After` se escribe en segundos enteros, así que el valor se redondea
 * hacia arriba: esperar de menos es lo que vuelve a chocar.
 *
 * Un valor que no es un número finito y no negativo se descarta en vez de
 * lanzar. Lanzar acá reemplazaría el error que se estaba construyendo por uno
 * que nadie pensó responder.
 */
function normalizeRetryAfter(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.ceil(seconds);
}

/**
 * La base común de los errores de Nova (ADR-031).
 *
 * No importa ningún framework web, y ése es el punto: el mismo caso de uso
 * corre detrás de HTTP o de un consumidor de cola, y quien lanza no sabe de
 * status. El HTTP lo decide la plataforma con `ErrorStatusMapper`.
 *
 * No se extiende directamente: se lanza una de las cuatro clases de capa, con
 * su fábrica por tipo, como `DomainError.notFound(...)`.
 *
 * @typeParam TType - el tipo enumerado de la capa.
 */
export abstract class NovaError<TType extends ErrorType = ErrorType>
  extends Error
  implements LayeredError
{
  readonly layer: Layer;
  readonly type: TType;
  readonly code?: string;
  readonly fieldErrors: readonly FieldError[];
  readonly retryAfter?: number;
  readonly upstream?: string;

  /**
   * Tomado del contexto de la petición al construir el error, y no al
   * responder: para entonces el contexto se puede haber perdido. En NestJS es
   * el id de correlación de la petición, el mismo de `x-request-id`.
   *
   * Ausente fuera de una petición -un job, un consumidor-, nunca inventado.
   */
  readonly traceId?: string;

  protected constructor(init: NovaErrorInit<TType>) {
    // `cause` sólo cuando hay una: con `{ cause: undefined }` la propiedad
    // existe igual y el log muestra una causa vacía.
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = new.target.name;
    this.layer = init.layer;
    this.type = init.type;
    this.code = init.code;
    this.fieldErrors = [...(init.fieldErrors ?? [])];
    this.retryAfter = normalizeRetryAfter(init.retryAfter);
    this.upstream = init.upstream;
    this.traceId = currentRequestId();
  }
}
