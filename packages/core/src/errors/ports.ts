import type {
  ApiFailure,
  ApiFailureKind,
  ApiWire,
} from '../api-standard/api-standard';
import type { ErrorType } from './error-type';
import type { Layer } from './layer';
import type { FieldError } from './nova-error';

// Los tres puertos de ADR-031. El módulo define el modelo y estos contratos;
// Nova trae una implementación de cada uno, y una organización pone la suya en
// su perfil sin forkear la plataforma.
//
// Ningún puerto recibe el error tal como nació. Lo que el error trae por dentro
// -el proveedor que falló, la causa, el mensaje real de una falla- va al log, y
// el núcleo lo escribe antes de llamar a cualquiera de ellos (ADR-034): un
// puerto propio no puede romper la regla de que un 5xx nunca revela al
// proveedor, porque no tiene de dónde sacarlo.

/**
 * Lo que ve el cliente de un error: su código y su mensaje.
 */
export type ErrorDescription = {
  readonly code: string;
  readonly message: string;
};

/**
 * Lo que {@link ErrorStatusMapper} ve de un error de Nova: cómo está
 * clasificado, y nada más.
 *
 * Un mapper devuelve un número y no puede filtrar nada, así que el código propio
 * viaja, por si una organización decide el status de un código en particular.
 * El proveedor, la causa y el mensaje no.
 */
export type ErrorClassification = {
  readonly layer: Layer;
  readonly type: ErrorType;
  readonly code?: string;
};

/**
 * Lo que {@link ErrorCatalog} ve de un fallo, ya saneado por el núcleo.
 *
 * `code`, `message` y `fieldErrors` son lo que el error puede decir: en un 5xx
 * el núcleo los quita, así que el catálogo pone su código y su mensaje
 * genérico. Nunca están el proveedor que falló ni la causa.
 */
export type SanitizedError = {
  /**
   * Por qué falló: la entrada no pasó la validación, el llamador pidió algo que
   * no corresponde, o el fallo es nuestro.
   */
  readonly kind: ApiFailureKind;
  readonly layer: Layer;
  /** Ausente sólo en una excepción del framework cuyo status no tiene fila. */
  readonly type: ErrorType | undefined;
  /** El código propio de quien lanzó. Nunca en un 5xx. */
  readonly code: string | undefined;
  /**
   * El mensaje propio de quien lanzó, para la persona. Ausente cuando el error
   * no trae uno -una excepción del framework sin mensaje- y siempre en un 5xx:
   * el catálogo pone el genérico.
   */
  readonly message: string | undefined;
  /** Los campos que fallaron. Vacío cuando el error no es de un campo, y en un 5xx. */
  readonly fieldErrors: readonly FieldError[];
};

/**
 * Decide el HTTP de cada capa y tipo.
 *
 * Sólo se consulta para los errores de Nova. Una excepción del framework ya trae
 * su status, y se respeta: así un servicio migra de a poco y lo que no cambió
 * sigue respondiendo igual.
 */
export interface ErrorStatusMapper {
  statusOf(error: ErrorClassification): number;
}

/**
 * Decide el código y el mensaje que ve el cliente.
 *
 * Recibe el status ya decidido porque la regla de Nova depende de él: un 5xx
 * nunca muestra el código propio ni el mensaje del error, y el catálogo pone su
 * mensaje genérico.
 */
export interface ErrorCatalog {
  describe(error: SanitizedError, status: number): ErrorDescription;
}

/**
 * Decide el cuerpo y las cabeceras de la respuesta de error.
 *
 * Es la mitad de los fallos de un {@link ApiStandard}: recibe el mismo
 * {@link ApiFailure}, ya clasificado y saneado, y devuelve lo mismo que
 * `failure()`. Sirve para cambiar sólo el cuerpo de los errores, como RFC 7807,
 * sin escribir un estándar entero.
 *
 * @see {@link ApiStandard}
 */
export interface ErrorSerializer {
  serialize(failure: ApiFailure): ApiWire;
}

/**
 * Los puertos que el filtro lee. El de status siempre está; los otros dos sólo
 * si el servicio o su perfil los declaró, porque si no los pone el estándar
 * activo.
 */
export type ErrorPorts = {
  readonly statusMapper: ErrorStatusMapper;
  readonly catalog?: ErrorCatalog;
  readonly serializer?: ErrorSerializer;
};
