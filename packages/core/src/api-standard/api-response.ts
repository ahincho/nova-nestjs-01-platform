import type { ApiErrorItem } from './api-error';

/**
 * Lo que acompaña a una respuesta sin ser su resultado ni uno de sus errores.
 *
 * Hoy lleva sólo el `traceId`, y sólo en las respuestas de error (ADR-031): es
 * lo que alguien puede citar al reportar una falla, porque es el mismo valor que
 * va en la línea de log. Una respuesta exitosa no lo trae en el cuerpo: el id ya
 * viaja en la cabecera `x-request-id`, y sumarlo ahí cambiaría el cuerpo de
 * todos los endpoints para no agregar nada.
 */
export type ApiMetadata = {
  /**
   * El id de la petición que falló. El filtro global siempre lo pone; `null`
   * sólo si otro serializador no lo tiene, y nunca ausente: quien lo lee
   * encuentra la clave en los dos casos.
   */
  readonly traceId: string | null;
};

/**
 * The envelope every Nova HTTP endpoint answers with, on success and on failure.
 *
 * `data` and `errors` are mutually exclusive by construction: a success carries
 * an empty `errors`, a failure carries `data: null`. Nothing enforces that at
 * the type level, which is why nobody should build this object literally -
 * `ApiResponses` is the only place allowed to, and it keeps the invariant.
 *
 * @typeParam T - the payload type of a successful response.
 */
export type ApiResponse<T> = {
  readonly success: boolean;
  readonly status: number;
  readonly data: T | null;
  readonly errors: readonly ApiErrorItem[];
  /**
   * Presente en las respuestas de error que arma el filtro global. Es opcional
   * en el tipo porque llegó después que el resto del sobre: un cliente que no
   * lo conoce sigue leyendo lo mismo que antes.
   */
  readonly metadata?: ApiMetadata;
};
