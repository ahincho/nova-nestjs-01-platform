import type { Dispatcher } from 'undici';

/**
 * DI token holding the resolved {@link NovaHttpModuleOptions}.
 */
export const NOVA_HTTP_OPTIONS = Symbol('NOVA_HTTP_OPTIONS');

/**
 * Token del transporte con el que el cliente hace cada llamada. Por defecto es
 * el `fetch` de undici.
 *
 * Existe para las pruebas. El cliente no usa el `fetch` global, así que
 * reemplazar `global.fetch` no intercepta nada; lo que se reemplaza es este
 * proveedor:
 *
 *     moduleRef.overrideProvider(NOVA_HTTP_TRANSPORT).useValue(fetchMock)
 */
export const NOVA_HTTP_TRANSPORT = Symbol('NOVA_HTTP_TRANSPORT');

/** Lo que el cliente le pasa al transporte en cada llamada. */
export type HttpTransportInit = {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
  readonly dispatcher?: Dispatcher;
};

/**
 * La forma del transporte: la de `fetch`, reducida a lo que el cliente usa.
 * Una prueba lo reemplaza con un `vi.fn()` que devuelve un `Response`.
 */
export type HttpTransport = (
  url: string,
  init: HttpTransportInit,
) => Promise<Response>;

/**
 * DI token for the optional {@link OutboundHeadersProvider}.
 */
export const OUTBOUND_HEADERS_PROVIDER = Symbol(
  'NOVA_OUTBOUND_HEADERS_PROVIDER',
);

/**
 * Supplies the headers every outbound call should carry.
 *
 * This is the seam that lets a correlation id travel from the incoming request
 * to the upstream without any call site passing it. It is an injected port
 * rather than a direct dependency so this package stays independent of how the
 * context is kept - `@ahincho/nova-nestjs-observability` provides one backed
 * by `AsyncLocalStorage`, and an application can provide its own.
 */
export interface OutboundHeadersProvider {
  headers(): Record<string, string>;
}

export type NovaHttpModuleOptions = {
  /**
   * How long a call may take before it is aborted, when the call site does not
   * say. Defaults to 5000.
   */
  readonly defaultTimeoutMs?: number;

  /**
   * Headers added to every outbound call, below the propagated ones and below
   * the ones the call site passes.
   */
  readonly defaultHeaders?: Record<string, string>;

  /**
   * El pool de conexiones compartido por todas las llamadas salientes. En
   * `false` cada llamada usa el despachador global de undici.
   *
   * Sin pool, cada petición abre y cierra un socket: a 20 llamadas concurrentes
   * contra el mismo upstream son 20 handshakes TCP. Medido con `connections: 2`
   * las mismas 20 llamadas usan 2 sockets.
   */
  readonly pool?: NovaHttpPoolOptions | false;
};

export type NovaHttpPoolOptions = {
  /** Techo de conexiones por origen. Por defecto 50. */
  readonly connections?: number;

  /** Peticiones encoladas por conexión. Por defecto 10. */
  readonly pipelining?: number;

  /** Cuánto se mantiene viva una conexión ociosa. Por defecto 30000. */
  readonly keepAliveTimeoutMs?: number;

  /**
   * Cuánto se espera a que terminen las llamadas en vuelo al apagar. Por
   * defecto 5000, por debajo del `stopTimeout` de una tarea de ECS -30 s-, para
   * volver a arrancar con un estado limpio en vez de que un upstream atascado
   * deje el cierre colgado hasta el SIGKILL.
   */
  readonly closeTimeoutMs?: number;
};

export type ResolvedNovaHttpOptions = {
  readonly defaultTimeoutMs: number;
  readonly defaultHeaders: Record<string, string>;
  readonly pool: ResolvedNovaHttpPoolOptions | false;
};

export type ResolvedNovaHttpPoolOptions = {
  readonly connections: number;
  readonly pipelining: number;
  readonly keepAliveTimeoutMs: number;
  readonly closeTimeoutMs: number;
};

export const DEFAULT_HTTP_TIMEOUT_MS = 5000;

export const DEFAULT_HTTP_POOL: ResolvedNovaHttpPoolOptions = {
  connections: 50,
  pipelining: 10,
  keepAliveTimeoutMs: 30_000,
  closeTimeoutMs: 5_000,
};

function resolvePool(
  pool: NovaHttpPoolOptions | false | undefined,
): ResolvedNovaHttpPoolOptions | false {
  if (pool === false) {
    return false;
  }
  return {
    connections: pool?.connections ?? DEFAULT_HTTP_POOL.connections,
    pipelining: pool?.pipelining ?? DEFAULT_HTTP_POOL.pipelining,
    keepAliveTimeoutMs:
      pool?.keepAliveTimeoutMs ?? DEFAULT_HTTP_POOL.keepAliveTimeoutMs,
    closeTimeoutMs: pool?.closeTimeoutMs ?? DEFAULT_HTTP_POOL.closeTimeoutMs,
  };
}

/**
 * Applies defaults field by field, so an explicitly passed `undefined` cannot
 * overwrite a default with `undefined`.
 */
export function resolveNovaHttpOptions(
  options: NovaHttpModuleOptions = {},
): ResolvedNovaHttpOptions {
  return {
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    defaultHeaders: options.defaultHeaders ?? {},
    pool: resolvePool(options.pool),
  };
}
