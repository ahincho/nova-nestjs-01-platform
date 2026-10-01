import { DEFAULT_REQUEST_ID_HEADER, type RequestLoggerOptions } from './logger';
import { DEFAULT_CORRELATION_HEADERS } from './request-context';

export const OBSERVABILITY_OPTIONS = Symbol('NOVA_OBSERVABILITY_OPTIONS');

/**
 * Cómo entra el id de correlación por el borde y cómo se devuelve (ADR-037).
 *
 * Es una decisión distinta de cómo viaja hacia adentro, que sigue siendo la
 * primera de `correlationHeaders`: un frontend puede mandarlo con su propio
 * nombre sin que los servicios de adentro tengan que enterarse.
 */
export type RequestIdOptions = {
  /**
   * De qué cabeceras se toma el id que manda el llamador, en orden: gana la
   * primera que traiga un valor. Por defecto, la cabecera con la que viaja.
   *
   * Una lista vacía no toma nunca el del llamador y lo genera siempre.
   */
  readonly accept?: readonly string[];

  /**
   * Con qué nombre se devuelve en la respuesta. Por defecto, la primera de
   * `accept`: el llamador lo recibe con el mismo nombre con que lo mandó.
   */
  readonly echo?: string;
};

export type NovaObservabilityModuleOptions = {
  /**
   * Headers carried from the incoming request onto every outbound one. The
   * first is the correlation id and is generated when the caller omits it.
   */
  readonly correlationHeaders?: readonly string[];

  /**
   * Cómo entra el id por el borde y cómo se devuelve. Por defecto, con el
   * mismo nombre con que viaja.
   */
  readonly requestId?: RequestIdOptions;

  /**
   * Produces a correlation id when the caller did not send one. Defaults to
   * `crypto.randomUUID`.
   */
  readonly generateId?: () => string;

  /**
   * Echoes the correlation id back on the response. Defaults to true - the
   * caller needs it to report a failure, and a browser can only read it because
   * the CORS policy exposes that header.
   */
  readonly echoRequestId?: boolean;

  /**
   * El logger estructurado, montado sobre `nestjs-pino`. Encendido por defecto:
   * el formato del log es un contrato con el recolector que lee esos documentos,
   * y dejarlo librado a cada servicio es lo que produce un contenedor sano cuyas
   * líneas no aparecen en ninguna consulta.
   *
   * En `false` la plataforma no monta ninguno y `bootstrap()` no instala nada,
   * que es lo que necesita un servicio que loguea de otra forma.
   */
  readonly logger?: RequestLoggerOptions | false;
};

export type ResolvedRequestIdOptions = {
  readonly accept: readonly string[];
  readonly echo: string;
};

export type ResolvedObservabilityOptions = {
  readonly correlationHeaders: readonly string[];
  readonly requestId: ResolvedRequestIdOptions;
  readonly generateId: () => string;
  readonly echoRequestId: boolean;
  readonly logger: RequestLoggerOptions | false;
};

export function resolveObservabilityOptions(
  options: NovaObservabilityModuleOptions = {},
): ResolvedObservabilityOptions {
  const correlationHeaders =
    options.correlationHeaders ?? DEFAULT_CORRELATION_HEADERS;
  const [propagation = DEFAULT_REQUEST_ID_HEADER] = correlationHeaders;
  const accept = options.requestId?.accept ?? [propagation];

  return {
    correlationHeaders,
    requestId: {
      accept,
      echo: options.requestId?.echo ?? accept[0] ?? propagation,
    },
    generateId: options.generateId ?? (() => crypto.randomUUID()),
    echoRequestId: options.echoRequestId ?? true,
    logger: options.logger ?? {},
  };
}
