import {
  DEFAULT_INTERNAL_ERROR_MESSAGE,
  NovaErrorCatalog,
  NovaErrorSerializer,
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
 * Token de los tres puertos del módulo de errores, ya resueltos: los que lee el
 * filtro global.
 */
export const ERROR_PORTS = Symbol('NOVA_ERROR_PORTS');

/**
 * Los puertos de ADR-031 que un servicio o un perfil de organización
 * reemplaza. El que no se declara queda con la implementación de Nova.
 *
 * Son instancias y no clases: un catálogo propio se arma con sus códigos y sus
 * textos, y no necesita nada de la inyección para existir.
 *
 * @example
 * NovaModule.forRoot({ errors: { catalog: new OrganizationErrorCatalog() } });
 */
export type NovaErrorsOptions = {
  /**
   * El código y el mensaje que ve el cliente. Por defecto, `NovaErrorCatalog`.
   */
  readonly catalog?: ErrorCatalog;
  /** El HTTP de cada capa y tipo. Por defecto, `NovaErrorStatusMapper`. */
  readonly statusMapper?: ErrorStatusMapper;
  /**
   * El cuerpo y las cabeceras. Por defecto, `NovaErrorSerializer`: el sobre de
   * Nova.
   */
  readonly serializer?: ErrorSerializer;
};

/**
 * Options accepted by `ApiStandardModule.forRoot()`.
 */
export type ApiStandardModuleOptions = {
  /**
   * Registers the global response interceptor. Turn it off only when the
   * application wraps responses itself. Defaults to `true`.
   */
  readonly wrapResponses?: boolean;

  /**
   * Registers the global exception filter. Defaults to `true`.
   */
  readonly catchExceptions?: boolean;

  /**
   * El mensaje de todo 5xx con el catálogo de Nova. Llega al cliente tal cual,
   * así que nunca lleva la falla de fondo. Un `errors.catalog` propio decide
   * sus mensajes y no lo lee. Por defecto `'Internal server error'`.
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
 * `errors` no está: no se resuelve a un valor sino a tres proveedores, y esos
 * viven bajo {@link ERROR_PORTS}.
 */
export type ResolvedApiStandardOptions = Required<
  Omit<ApiStandardModuleOptions, 'errors'>
>;

export const DEFAULT_API_STANDARD_OPTIONS: ResolvedApiStandardOptions = {
  wrapResponses: true,
  catchExceptions: true,
  internalErrorMessage: DEFAULT_INTERNAL_ERROR_MESSAGE,
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
    internalErrorMessage:
      options.internalErrorMessage ??
      DEFAULT_API_STANDARD_OPTIONS.internalErrorMessage,
  };
}

/**
 * Completa los puertos con los de Nova, uno por uno y no con un spread, por la
 * misma razón que las opciones.
 *
 * El catálogo de Nova se arma con `internalErrorMessage`: así la opción de
 * siempre sigue funcionando sin que nadie declare un catálogo.
 */
export function resolveErrorPorts(
  options: NovaErrorsOptions = {},
  internalErrorMessage: string = DEFAULT_INTERNAL_ERROR_MESSAGE,
): ErrorPorts {
  return {
    catalog: options.catalog ?? new NovaErrorCatalog({ internalErrorMessage }),
    statusMapper: options.statusMapper ?? new NovaErrorStatusMapper(),
    serializer: options.serializer ?? new NovaErrorSerializer(),
  };
}
