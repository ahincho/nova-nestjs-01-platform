import {
  UpstreamException,
  statusForReceived,
  type OutboundCall,
  type UpstreamFailure,
} from './upstream-failure';

/**
 * The upstream answered, and it answered with a failure.
 *
 * Only raised when the call site asked for it with `forwardError: true`. By
 * default an upstream failure is translated into a 502 or a 504 before it can
 * reach the client, because the upstream's own status describes a topology the
 * caller should not learn about.
 *
 * Es una {@link UpstreamException} con la misma clasificación que tendría sin
 * `forwardError`, y eso es lo que hace seguro el patrón de siempre: el llamador
 * traduce el status que entiende y relanza el resto, y el resto sale como 502 o
 * 504, clasificado. Cuando era un `Error` suelto, lo relanzado llegaba al filtro
 * como un fallo propio y salía 500: el tablero contaba un defecto nuestro donde
 * había fallado el upstream.
 */
export class UpstreamHttpError extends UpstreamException {
  /**
   * `failure` y `call` los pone el cliente HTTP. Construida a mano -en una
   * prueba, por ejemplo- no sabe a qué host llamó ni cuánto tardó.
   */
  constructor(
    readonly statusCode: number,
    readonly body: unknown,
    readonly headers: Record<string, string>,
    failure: UpstreamFailure = {
      upstream: 'unknown',
      category: 'response',
      phase: 'response',
      receivedStatus: statusCode,
      elapsedMs: 0,
      status: statusForReceived(statusCode),
    },
    call?: OutboundCall,
  ) {
    super(failure, undefined, call);
    this.name = 'UpstreamHttpError';
    this.message = `Upstream responded ${statusCode}`;
  }
}
