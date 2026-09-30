import type { LayeredError, NovaError } from './nova-error';

// Los tres puertos de ADR-031. El módulo define el modelo y estos contratos;
// Nova trae una implementación de cada uno, y una organización pone la suya en
// su perfil sin forkear la plataforma.

/**
 * Lo que ve el cliente de un error: su código y su mensaje.
 */
export type ErrorDescription = {
  readonly code: string;
  readonly message: string;
};

/**
 * Lo que el servicio contesta, ya decidido por los otros dos puertos.
 */
export type ErrorReply = ErrorDescription & {
  /** El status HTTP de la respuesta. */
  readonly status: number;
  /**
   * El id que se puede citar: el que el error tomó al nacer, o si no tomó
   * ninguno, el de la petición que se está contestando. Ausente sólo fuera de
   * una petición con contexto.
   */
  readonly traceId?: string;
};

/**
 * El cuerpo y las cabeceras de una respuesta de error. El status no está: ése
 * lo decide {@link ErrorStatusMapper}.
 */
export type SerializedError = {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
};

/**
 * Decide el HTTP de cada capa y tipo.
 *
 * Sólo se consulta para los errores de Nova. Una excepción del framework ya trae
 * su status, y se respeta: así un servicio migra de a poco y lo que no cambió
 * sigue respondiendo igual.
 */
export interface ErrorStatusMapper {
  statusOf(error: NovaError): number;
}

/**
 * Decide el código y el mensaje que ve el cliente.
 *
 * Recibe el status ya decidido porque la regla de Nova depende de él: un 5xx
 * nunca muestra el código propio, el mensaje ni el proveedor.
 */
export interface ErrorCatalog {
  describe(error: LayeredError, status: number): ErrorDescription;
}

/**
 * Decide el cuerpo y las cabeceras de la respuesta.
 *
 * Es el lugar para otro formato de cuerpo, como RFC 7807: el de Nova es el sobre
 * `{ success, status, data, errors, metadata }`.
 */
export interface ErrorSerializer {
  serialize(error: LayeredError, reply: ErrorReply): SerializedError;
}

/**
 * Los tres puertos juntos, como los recibe el filtro de excepciones.
 */
export type ErrorPorts = {
  readonly catalog: ErrorCatalog;
  readonly statusMapper: ErrorStatusMapper;
  readonly serializer: ErrorSerializer;
};
