import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { fetch, type Dispatcher } from 'undici';
import { NovaHttpAgent } from './http-agent';
import {
  NOVA_HTTP_OPTIONS,
  NOVA_HTTP_TRANSPORT,
  OUTBOUND_HEADERS_PROVIDER,
  type HttpTransport,
  type OutboundHeadersProvider,
  type ResolvedNovaHttpOptions,
} from './tokens';
import {
  UpstreamException,
  classifyTransportError,
  statusForReceived,
  statusForType,
  type OutboundCall,
  type UpstreamErrorType,
  type UpstreamFailure,
  type UpstreamFailureCategory,
  type UpstreamFailurePhase,
} from './upstream-failure';
import { UpstreamHttpError } from './upstream-http.error';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export type QueryValue = string | number | boolean | undefined | null;

export type HttpRequestOptions = {
  /** Merged over the propagated and default headers. */
  readonly headers?: Record<string, string>;

  /** Appended as a query string. `undefined` and `null` entries are dropped. */
  readonly query?: Record<string, QueryValue>;

  /** Serialised as JSON. Omitted entirely when `undefined`. */
  readonly body?: unknown;

  /** Overrides the module-wide timeout for this call. */
  readonly timeoutMs?: number;

  /**
   * Raises {@link UpstreamHttpError} with the upstream status and body instead
   * of translating the failure to a 502 or a 504. Use it when the caller has to
   * map the upstream's own semantics - a 404 that should stay a 404, say.
   *
   * Lo que el llamador no traduzca y relance sale igual que sin esta opción:
   * 502 o 504, clasificado.
   */
  readonly forwardError?: boolean;

  /**
   * Despachador propio para esta llamada, en vez del pool compartido. Es la
   * salida para el upstream que necesita el suyo -- otro TLS, un certificado
   * fijado -- sin que eso obligue a un pool por upstream.
   */
  readonly dispatcher?: Dispatcher;
};

type Call = {
  readonly method: HttpMethod;
  readonly target: string;
  readonly timeoutMs: number;
  readonly startedAt: number;
};

type FailureDetail = {
  readonly category: UpstreamFailureCategory;
  readonly phase: UpstreamFailurePhase;
  readonly status: number;
  readonly type?: UpstreamErrorType;
  readonly receivedStatus?: number;
  readonly code?: string;
};

/**
 * The outbound HTTP client every Nova service calls its upstreams through.
 *
 * Built on undici's `fetch` -- not the global one -- because the pool has to be
 * an `Agent` of this same undici, and el `fetch` de Node no lo acepta: viene con
 * su propia copia de undici embebida y rechaza un despachador de la otra con
 * `InvalidArgumentError: invalid onRequestStart method`. Comprobado sobre Node
 * 24.18 y undici 8.10. Llega por {@link NOVA_HTTP_TRANSPORT}, que es lo que una
 * prueba reemplaza.
 *
 * What it adds over a bare `fetch` is the part that was being rewritten in
 * every service: a timeout that is always set, a connection pool instead of a
 * socket per call, correlation headers that travel on their own, and an
 * upstream failure that cannot reach the client verbatim.
 *
 * Todo fallo sale como {@link UpstreamException}, clasificado con el registro
 * de RFC 9209: el tipo y la categoría dicen de quién es el problema, y viajan
 * como campos del log en vez de perderse en un stack (ADR-035).
 *
 * El cliente no registra los fallos: lanza, y la excepción lleva los campos. Lo
 * registra una sola vez quien decide qué hacer con él -el filtro de errores si
 * nadie lo atrapa-. Registrarlo también acá dejaba dos líneas de error por cada
 * fallo, y una tercera, falsa, cuando el llamador lo había resuelto.
 */
@Injectable()
export class HttpClientService {
  private readonly logger = new Logger(HttpClientService.name);

  constructor(
    @Inject(NOVA_HTTP_OPTIONS)
    private readonly options: ResolvedNovaHttpOptions,
    @Optional()
    @Inject(OUTBOUND_HEADERS_PROVIDER)
    private readonly headersProvider?: OutboundHeadersProvider,
    @Optional()
    private readonly agent?: NovaHttpAgent,
    // Opcional para que construirlo a mano siga llamando de verdad.
    @Optional()
    @Inject(NOVA_HTTP_TRANSPORT)
    private readonly transport: HttpTransport = fetch,
  ) {}

  get<T>(url: string, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('GET', url, options);
  }

  post<T>(
    url: string,
    body: unknown,
    options?: HttpRequestOptions,
  ): Promise<T> {
    return this.request<T>('POST', url, { ...options, body });
  }

  put<T>(url: string, body: unknown, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('PUT', url, { ...options, body });
  }

  patch<T>(
    url: string,
    body: unknown,
    options?: HttpRequestOptions,
  ): Promise<T> {
    return this.request<T>('PATCH', url, { ...options, body });
  }

  delete<T>(url: string, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('DELETE', url, options);
  }

  async request<T>(
    method: HttpMethod,
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<T> {
    const call: Call = {
      method,
      target: this.withQuery(url, options.query),
      timeoutMs: options.timeoutMs ?? this.options.defaultTimeoutMs,
      startedAt: Date.now(),
    };

    const response = await this.send(call, options);
    const text = await this.read(call, response);

    if (response.status >= 400) {
      return this.fail(call, response, text, options);
    }

    return this.parse<T>(call, text);
  }

  private async send(
    call: Call,
    options: HttpRequestOptions,
  ): Promise<Response> {
    try {
      return await this.transport(call.target, {
        method: call.method,
        headers: {
          'content-type': 'application/json',
          ...this.options.defaultHeaders,
          ...this.propagatedHeaders(),
          ...options.headers,
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        // AbortSignal.timeout is what guarantees the call cannot outlive the
        // timeout even if the upstream keeps the socket open while sending
        // nothing, which a header-only deadline does not cover.
        signal: AbortSignal.timeout(call.timeoutMs),
        // Sin despachador cae en el global de undici, que abre un socket por
        // llamada. Es lo que pasa cuando el módulo apagó el pool.
        ...this.dispatcherFor(options),
      });
    } catch (cause) {
      const { type, category, code } = classifyTransportError(cause, 'request');

      throw this.exception(
        call,
        {
          type,
          category,
          // Lo que falló antes de tener respuesta: si fue la conectividad, la
          // conexión ni se estableció.
          phase: category === 'connectivity' ? 'connect' : 'response',
          status: statusForType(type),
          ...(code === undefined ? {} : { code }),
        },
        cause,
      );
    }
  }

  /**
   * Lee el cuerpo dentro de la clasificación.
   *
   * Fuera de ella, un upstream que corta la respuesta a mitad producía un
   * `TypeError` sin traducir, y el filtro lo contestaba como 500: el tablero
   * contaba un defecto propio donde hubo un problema de red.
   */
  private async read(call: Call, response: Response): Promise<string> {
    try {
      return await response.text();
    } catch (cause) {
      const { type, category, code } = classifyTransportError(cause, 'body');

      throw this.exception(
        call,
        {
          type,
          category,
          phase: 'body',
          status: statusForType(type),
          ...(code === undefined ? {} : { code }),
        },
        cause,
      );
    }
  }

  private fail<T>(
    call: Call,
    response: Response,
    text: string,
    options: HttpRequestOptions,
  ): T {
    // El upstream contestó, así que no es un tipo de error del RFC sino su
    // `received-status`. Se sigue sin reenviar el status propio del upstream:
    // describe una topología que el cliente no tiene por qué conocer.
    const failure = this.failure(call, {
      category: 'response',
      phase: 'response',
      receivedStatus: response.status,
      status: statusForReceived(response.status),
    });

    if (options.forwardError) {
      // El cuerpo va en la excepción, para el llamador, y nunca al log: un
      // cuerpo de error del upstream suele devolver los identificadores de la
      // persona sobre la que era la petición.
      throw new UpstreamHttpError(
        response.status,
        this.parseLenient(text),
        Object.fromEntries(response.headers),
        failure,
        this.outbound(call),
      );
    }

    throw new UpstreamException(failure, undefined, this.outbound(call));
  }

  private parse<T>(call: Call, text: string): T {
    if (text === '') {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      // Antes se devolvía el texto como si fuera un `T`, y el error aparecía más
      // adelante, en el código que usó el resultado, lejos de la causa. Un 2xx
      // que no se puede interpretar es un contrato roto y se dice acá.
      throw this.exception(
        call,
        {
          type: 'http_response_content_invalid',
          category: 'contract',
          phase: 'body',
          status: statusForType('http_response_content_invalid'),
        },
        cause,
      );
    }
  }

  /**
   * El cuerpo de un error que el llamador pidió recibir. Acá sí vale el texto:
   * un gateway que contesta HTML en un error es lo habitual, y el llamador
   * decide qué hacer con él.
   */
  private parseLenient(text: string): unknown {
    if (text === '') {
      return undefined;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /** Arma la excepción de un fallo que no fue una respuesta de error. */
  private exception(
    call: Call,
    detail: FailureDetail,
    cause: unknown,
  ): UpstreamException {
    return new UpstreamException(
      this.failure(call, detail),
      cause,
      this.outbound(call),
    );
  }

  /**
   * La clasificación, con el upstream nombrado por su host y la duración de la
   * llamada. Va como campos del log y no dentro del mensaje: un tablero cuenta
   * por `upstream.category` sin parsear texto.
   */
  private failure(call: Call, detail: FailureDetail): UpstreamFailure {
    return {
      upstream: this.hostOf(call.target),
      elapsedMs: Date.now() - call.startedAt,
      ...detail,
    };
  }

  /** La llamada, tal como puede llegar a un log. */
  private outbound(call: Call): OutboundCall {
    return {
      method: call.method,
      url: this.safeUrl(call.target),
      timeoutMs: call.timeoutMs,
    };
  }

  private dispatcherFor(options: HttpRequestOptions): {
    dispatcher?: Dispatcher;
  } {
    const dispatcher = options.dispatcher ?? this.agent?.dispatcher();
    return dispatcher === undefined ? {} : { dispatcher };
  }

  private propagatedHeaders(): Record<string, string> {
    try {
      return this.headersProvider?.headers() ?? {};
    } catch (cause) {
      // Losing the correlation id degrades a trace. Failing the call because
      // the context could not be read would turn that into an outage.
      //
      // La causa va en `err` y no pegada al mensaje, que así queda uno solo
      // para agrupar.
      this.logger.warn(
        { err: cause },
        'Could not build the propagated headers',
      );
      return {};
    }
  }

  private withQuery(url: string, query?: Record<string, QueryValue>): string {
    if (!query) {
      return url;
    }

    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    }

    const serialised = params.toString();

    if (serialised === '') {
      return url;
    }

    return url.includes('?') ? `${url}&${serialised}` : `${url}?${serialised}`;
  }

  /** El host del upstream, que es lo único de la URL seguro para un log. */
  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Strips the query string and any credentials before a URL reaches a log.
   *
   * A query string carries identifiers of the person the request was about, and
   * those must not end up in a log index that more people can read than can
   * read the database.
   */
  private safeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.search = '';
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return url.split('?')[0] ?? url;
    }
  }
}
