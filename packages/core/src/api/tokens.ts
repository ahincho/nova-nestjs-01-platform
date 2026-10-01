import type { Type } from '@nestjs/common';
import type { ApiStandard } from '../api-standard';
import {
  NovaErrorStatusMapper,
  type ErrorCatalog,
  type ErrorPorts,
  type ErrorSerializer,
  type ErrorStatusMapper,
} from '../errors';

/**
 * DI token holding the resolved {@link ApiStandardModuleOptions}.
 */
export const API_STANDARD_OPTIONS = Symbol('NOVA_API_STANDARD_OPTIONS');

/**
 * Token del {@link ApiStandard} activo: el que le da forma a todo lo que el
 * servicio contesta.
 */
export const API_STANDARD = Symbol('NOVA_API_STANDARD');

/**
 * Token de los puertos del módulo de errores que el servicio declaró, con el de
 * status ya resuelto: los que lee el filtro global.
 */
export const ERROR_PORTS = Symbol('NOVA_ERROR_PORTS');

/**
 * Los puertos de ADR-031 que un servicio o un perfil de organización
 * reemplaza. El que no se declara queda con el de Nova.
 *
 * Son instancias y no clases: un catálogo propio se arma con sus códigos y sus
 * textos, y no necesita nada de la inyección para existir.
 *
 * Ninguno recibe el error como nació: el núcleo escribe el log con el proveedor
 * y la causa, y les entrega un fallo ya saneado (ADR-034). Por eso ninguno
 * puede romper la regla de que un 5xx nunca revela al proveedor.
 *
 * @example
 * NovaModule.forRoot({ errors: { catalog: new OrganizationErrorCatalog() } });
 */
export type NovaErrorsOptions = {
  /**
   * El código y el mensaje que ve el cliente. Por defecto el catálogo del
   * estándar activo y, si no trae uno, `NovaErrorCatalog`.
   */
  readonly catalog?: ErrorCatalog;

  /** El HTTP de cada capa y tipo. Por defecto, `NovaErrorStatusMapper`. */
  readonly statusMapper?: ErrorStatusMapper;

  /**
   * El cuerpo y las cabeceras de un error. Por defecto, la mitad de los fallos
   * del estándar activo: con el de Nova, el sobre con `metadata.traceId`.
   * Cambia sólo los errores; para cambiar también los éxitos y el documento,
   * declarar `apiStandard.standard`.
   */
  readonly serializer?: ErrorSerializer;
};

/**
 * Options accepted by `ApiStandardModule.forRoot()`.
 */
export type ApiStandardModuleOptions = {
  /**
   * El estándar con el que contesta el servicio. Omitirlo usa el sobre de Nova,
   * `NovaEnvelopeStandard`.
   *
   * Acepta una instancia o una clase. Una clase se resuelve por inyección, así
   * que puede recibir dependencias; una instancia es para el estándar que se
   * arma con opciones fijas, como un catálogo de códigos propio.
   *
   * Reemplazarlo cambia la forma del cuerpo y nada más: qué respuestas pasan
   * por el estándar y qué se le dice al cliente en un 5xx siguen siendo reglas
   * de la plataforma.
   */
  readonly standard?: ApiStandard | Type<ApiStandard>;

  /**
   * Registers the global response interceptor. Defaults to `true`.
   *
   * @deprecated Para contestar con otra forma, declarar `standard`. Apagar el
   * interceptor se lleva con él las reglas -el caso que no es HTTP,
   * `@SkipResponseWrapper()`, el doble sobre- y el servicio las tiene que
   * reescribir. Sigue funcionando mientras tanto.
   */
  readonly wrapResponses?: boolean;

  /**
   * Registers the global exception filter. Defaults to `true`.
   *
   * @deprecated Para contestar los errores con otra forma, declarar
   * `standard`. Apagar el filtro se lleva el saneado de los 5xx, que es
   * justamente lo que un servicio no debería tener que reescribir. Sigue
   * funcionando mientras tanto.
   */
  readonly catchExceptions?: boolean;

  /**
   * El mensaje de todo 5xx. Llega al cliente tal cual, así que nunca lleva la
   * falla de fondo. Sin él, cada 5xx lleva el mensaje genérico de su status, en
   * español: «Error interno del servidor» para un 500, «Una dependencia no
   * respondió a tiempo» para un 504. Un `errors.catalog` propio decide sus
   * mensajes y no lo lee.
   */
  readonly internalErrorMessage?: string;

  /**
   * Los puertos del módulo de errores. Dentro de `NovaModule` se declaran en su
   * propia opción `errors`, que es la que documenta ADR-031.
   */
  readonly errors?: NovaErrorsOptions;
};

/**
 * {@link ApiStandardModuleOptions} with every default applied.
 *
 * `standard` y `errors` no están: no se resuelven a un valor sino a
 * proveedores, y esos viven bajo {@link API_STANDARD} y {@link ERROR_PORTS}.
 * `internalErrorMessage` puede quedar sin valor, y entonces cada 5xx lleva el
 * mensaje de su status.
 */
export type ResolvedApiStandardOptions = {
  readonly wrapResponses: boolean;
  readonly catchExceptions: boolean;
  readonly internalErrorMessage: string | undefined;
};

export const DEFAULT_API_STANDARD_OPTIONS: ResolvedApiStandardOptions = {
  wrapResponses: true,
  catchExceptions: true,
  internalErrorMessage: undefined,
};

/**
 * Applies defaults field by field.
 *
 * Not a spread: `{ ...defaults, ...options }` lets an explicitly passed
 * `undefined` overwrite a default with `undefined`, which then reads as
 * "disabled" at every call site.
 */
export function resolveApiStandardOptions(
  options: ApiStandardModuleOptions = {},
): ResolvedApiStandardOptions {
  return {
    wrapResponses:
      options.wrapResponses ?? DEFAULT_API_STANDARD_OPTIONS.wrapResponses,
    catchExceptions:
      options.catchExceptions ?? DEFAULT_API_STANDARD_OPTIONS.catchExceptions,
    internalErrorMessage: options.internalErrorMessage,
  };
}

/**
 * Completa el puerto de status con el de Nova y deja pasar los otros dos sólo si
 * se declararon, uno por uno y no con un spread, por la misma razón que las
 * opciones.
 *
 * El catálogo y el serializador que no se declaran no se completan acá: los pone
 * el estándar activo, que a veces trae los suyos, y el filtro es quien lo sabe.
 */
export function resolveErrorPorts(options: NovaErrorsOptions = {}): ErrorPorts {
  return {
    statusMapper: options.statusMapper ?? new NovaErrorStatusMapper(),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.serializer === undefined
      ? {}
      : { serializer: options.serializer }),
  };
}
