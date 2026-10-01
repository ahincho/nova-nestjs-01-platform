import { HttpException } from '@nestjs/common';

/**
 * A quién le toca un fallo de upstream. Es lo primero que alguien necesita
 * saber cuando una llamada falla, y cada categoría tiene un responsable
 * distinto (ADR-035).
 */
export type UpstreamFailureCategory =
  /** No se llegó a hablar con el upstream: DNS, puerto, ruta, TLS. */
  | 'connectivity'
  /** Se llegó, y no contestó a tiempo. */
  | 'timeout'
  /** Contestaba, y la conexión se cortó o la respuesta llegó rota. */
  | 'network'
  /** Contestó, con un status de error. */
  | 'response'
  /** Contestó 2xx con un cuerpo que no se puede usar. */
  | 'contract'
  /** El fallo es nuestro, antes de salir. */
  | 'internal';

/**
 * El tipo de error, tomado del registro de RFC 9209.
 *
 * `http_response_content_invalid` es la única extensión propia: el registro no
 * tiene un tipo para un cuerpo que no se puede interpretar.
 */
export type UpstreamErrorType =
  | 'dns_error'
  | 'dns_timeout'
  | 'destination_ip_unroutable'
  | 'connection_refused'
  | 'connection_timeout'
  | 'tls_certificate_error'
  | 'tls_protocol_error'
  | 'http_response_timeout'
  | 'connection_read_timeout'
  | 'connection_terminated'
  | 'http_response_incomplete'
  | 'http_protocol_error'
  | 'http_response_content_invalid'
  | 'proxy_internal_error'
  | 'proxy_configuration_error';

/**
 * Dónde estaba la llamada cuando falló: estableciendo la conexión, esperando la
 * respuesta o leyendo el cuerpo.
 */
export type UpstreamFailurePhase = 'connect' | 'response' | 'body';

/**
 * Un fallo de una llamada saliente, ya clasificado.
 *
 * Todo lo que tiene es seguro para un log: el upstream se identifica por su
 * host, nunca por la URL completa, porque una ruta o una query llevan
 * identificadores de la persona sobre la que era la petición.
 */
export type UpstreamFailure = {
  /** El host del upstream, sin ruta ni query. */
  readonly upstream: string;
  readonly category: UpstreamFailureCategory;
  /** Ausente cuando el upstream contestó con un status de error. */
  readonly type?: UpstreamErrorType;
  /** El status que contestó el upstream, cuando contestó. */
  readonly receivedStatus?: number;
  /** El código crudo del sistema -`ECONNREFUSED`, `UND_ERR_SOCKET`-, como dato. */
  readonly code?: string;
  readonly phase: UpstreamFailurePhase;
  readonly elapsedMs: number;
  /** El status con el que contesta este servicio. */
  readonly status: number;
};

/**
 * La llamada que falló: el método, la URL sin query ni credenciales y el plazo
 * que tenía.
 *
 * Va aparte de {@link UpstreamFailure} porque sirven para cosas distintas. La
 * clasificación es para contar y alertar, y por eso nombra al upstream sólo por
 * su host. La ruta puede llevar identificadores de la persona sobre la que era
 * la petición: sirve para leer una línea concreta, no para agrupar.
 */
export type OutboundCall = {
  readonly method: string;
  /** Esquema, host y ruta. */
  readonly url: string;
  readonly timeoutMs: number;
};

/**
 * Los campos que una excepción de upstream agrega a la línea de log del filtro
 * de errores.
 */
export type UpstreamLogFields = {
  readonly upstream: UpstreamFailure;
  readonly outbound?: OutboundCall;
};

type Classification = {
  readonly type: UpstreamErrorType;
  readonly category: UpstreamFailureCategory;
  readonly code?: string;
};

/**
 * Los códigos de certificado que expone Node. Van aparte del resto de TLS
 * porque se arreglan distinto: un certificado vencido o sin la CA instalada no
 * es un problema de protocolo.
 */
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * El tipo de cada código conocido. Salió de provocar cada fallo contra un
 * servidor real con undici 8.10 (ADR-035), no de la documentación: los que no
 * se pudieron provocar están marcados.
 */
const TYPE_BY_CODE: Readonly<Record<string, UpstreamErrorType>> = {
  ENOTFOUND: 'dns_error',
  // No provocado: es el fallo temporal de resolución, que en la práctica es el
  // servidor de nombres sin contestar.
  EAI_AGAIN: 'dns_timeout',
  ECONNREFUSED: 'connection_refused',
  // No provocados: dependen de la tabla de rutas de la máquina.
  EHOSTUNREACH: 'destination_ip_unroutable',
  ENETUNREACH: 'destination_ip_unroutable',
  UND_ERR_CONNECT_TIMEOUT: 'connection_timeout',
  // El timeout de conexión del sistema operativo, cuando undici no llegó a
  // disparar el suyo.
  ETIMEDOUT: 'connection_timeout',
  UND_ERR_HEADERS_TIMEOUT: 'http_response_timeout',
  // No provocado: undici lo lanza cuando el cuerpo deja de llegar.
  UND_ERR_BODY_TIMEOUT: 'connection_read_timeout',
  UND_ERR_RES_CONTENT_LENGTH_MISMATCH: 'http_response_incomplete',
  ERR_INVALID_URL: 'proxy_configuration_error',
};

const CATEGORY_BY_TYPE: Readonly<
  Record<UpstreamErrorType, UpstreamFailureCategory>
> = {
  dns_error: 'connectivity',
  dns_timeout: 'connectivity',
  destination_ip_unroutable: 'connectivity',
  connection_refused: 'connectivity',
  // Conectividad y no lentitud, a propósito: una conexión que no se establece
  // casi nunca es un upstream lento, es un paquete que alguien descarta. Se
  // arregla con configuración de red, no pidiéndole al otro equipo que sea más
  // rápido (ADR-035).
  connection_timeout: 'connectivity',
  tls_certificate_error: 'connectivity',
  tls_protocol_error: 'connectivity',
  http_response_timeout: 'timeout',
  connection_read_timeout: 'timeout',
  connection_terminated: 'network',
  http_response_incomplete: 'network',
  http_protocol_error: 'network',
  http_response_content_invalid: 'contract',
  proxy_internal_error: 'internal',
  proxy_configuration_error: 'internal',
};

/** El status que recomienda RFC 9209 para cada tipo. */
const STATUS_BY_TYPE: Readonly<Record<UpstreamErrorType, number>> = {
  dns_error: 502,
  dns_timeout: 504,
  destination_ip_unroutable: 502,
  connection_refused: 502,
  connection_timeout: 504,
  tls_certificate_error: 502,
  tls_protocol_error: 502,
  http_response_timeout: 504,
  connection_read_timeout: 504,
  connection_terminated: 502,
  http_response_incomplete: 502,
  http_protocol_error: 502,
  http_response_content_invalid: 502,
  proxy_internal_error: 500,
  proxy_configuration_error: 500,
};

type ErrorLike = {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
};

function asErrorLike(value: unknown): ErrorLike | undefined {
  return typeof value === 'object' && value !== null ? value : undefined;
}

/**
 * La cadena de causas, de afuera hacia adentro.
 *
 * `fetch` envuelve todo fallo de red en un `TypeError: fetch failed` y deja el
 * error real en `cause`; lo que se clasifica es ese de adentro. Se corta en
 * cinco niveles para no quedar atrapado en una cadena circular.
 */
function causes(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  let current = asErrorLike(error);

  while (current && chain.length < 5) {
    chain.push(current);
    current = asErrorLike(current.cause);
  }

  return chain;
}

function typeOf(
  error: ErrorLike,
  stage: 'request' | 'body',
): UpstreamErrorType | undefined {
  // El plazo propio de la llamada. Llega sin envolver y puede vencer en
  // cualquier momento, también mientras se lee el cuerpo.
  if (error.name === 'TimeoutError') {
    return 'http_response_timeout';
  }

  if (error.name === 'HTTPParserError') {
    return 'http_protocol_error';
  }

  // Un puerto que el estándar de fetch prohíbe -el 9, el 25, el 6000- se
  // rechaza antes de conectar y sin código, sólo con este mensaje. Es una URL
  // mal configurada, y sin reconocerlo caería como un fallo interno genérico.
  // Visto al arrancar el servicio de ejemplo contra el puerto 9.
  if (error.message === 'bad port') {
    return 'proxy_configuration_error';
  }

  const code = typeof error.code === 'string' ? error.code : undefined;

  if (code === undefined) {
    return undefined;
  }

  // Una conexión que se corta es lo mismo del lado del socket, pero no del
  // lado de quien diagnostica: antes de la respuesta el upstream la rechazó o
  // se cayó; a mitad del cuerpo, la respuesta llegó rota.
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'EPIPE') {
    return stage === 'body'
      ? 'http_response_incomplete'
      : 'connection_terminated';
  }

  if (CERTIFICATE_CODES.has(code)) {
    return 'tls_certificate_error';
  }

  if (code.startsWith('ERR_SSL_') || code === 'EPROTO') {
    return 'tls_protocol_error';
  }

  if (code.startsWith('HPE_')) {
    return 'http_protocol_error';
  }

  return TYPE_BY_CODE[code];
}

/**
 * Clasifica un error lanzado al llamar a un upstream o al leer su respuesta.
 *
 * Lo que no se reconoce cae en `proxy_internal_error`. No es un descuido:
 * `fetch` envuelve todo fallo de red con su causa, así que un error sin causa
 * reconocible casi siempre nació antes de salir -una cabecera inválida, un
 * cuerpo que no se pudo serializar-, y es nuestro.
 */
export function classifyTransportError(
  error: unknown,
  stage: 'request' | 'body',
): Classification {
  for (const link of causes(error)) {
    const type = typeOf(link, stage);

    if (type !== undefined) {
      const code = typeof link.code === 'string' ? link.code : undefined;
      return {
        type,
        category: CATEGORY_BY_TYPE[type],
        ...(code === undefined ? {} : { code }),
      };
    }
  }

  const code = causes(error)
    .map((link) => link.code)
    .find((value): value is string => typeof value === 'string');

  return {
    type: 'proxy_internal_error',
    category: 'internal',
    ...(code === undefined ? {} : { code }),
  };
}

/** El status con el que contesta este servicio ante un tipo de fallo. */
export function statusForType(type: UpstreamErrorType): number {
  return STATUS_BY_TYPE[type];
}

/**
 * El status con el que contesta este servicio cuando el upstream contestó con
 * uno de error. No se reenvía el del upstream: describe una topología que el
 * cliente no tiene por qué conocer.
 */
export function statusForReceived(receivedStatus: number): number {
  return receivedStatus === 504 || receivedStatus === 408 ? 504 : 502;
}

/** La categoría de un tipo de fallo. */
export function categoryForType(
  type: UpstreamErrorType,
): UpstreamFailureCategory {
  return CATEGORY_BY_TYPE[type];
}

function messageFor(failure: UpstreamFailure): string {
  if (failure.status === 504) {
    return 'Upstream service timed out';
  }
  if (failure.status === 500) {
    return 'Upstream call could not be made';
  }
  return 'Upstream service error';
}

/**
 * Una llamada a un upstream que falló, con su clasificación.
 *
 * Es una `HttpException` con el status que corresponde al tipo, así que un
 * servicio que no la atrapa contesta lo correcto sin hacer nada. El mensaje es
 * genérico a propósito: el filtro lo sanea igual, y el detalle va en
 * {@link UpstreamException.failure}, que llega al log y nunca al cuerpo.
 *
 * El cliente no registra el fallo: lo registra una sola vez quien termina
 * decidiendo qué hacer con él. Si nadie la atrapa, es el filtro de errores, con
 * estos campos en su línea; si el llamador la atrapa para degradar la
 * respuesta, el log es suyo, y {@link UpstreamException.logFields} es lo que
 * tiene que registrar.
 */
export class UpstreamException extends HttpException {
  /**
   * Los campos que esta excepción agrega a la línea de log del filtro de
   * errores. El filtro los lee por su forma, sin importar este módulo.
   */
  readonly logFields: UpstreamLogFields;

  constructor(
    readonly failure: UpstreamFailure,
    cause?: unknown,
    call?: OutboundCall,
  ) {
    super(
      messageFor(failure),
      failure.status,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'UpstreamException';
    this.logFields =
      call === undefined
        ? { upstream: failure }
        : { upstream: failure, outbound: call };
  }
}
