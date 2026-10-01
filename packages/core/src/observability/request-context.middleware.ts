import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { buildRequestContext, type IncomingHeaders } from './request-context';
import { RequestContextService } from './request-context.service';
import {
  OBSERVABILITY_OPTIONS,
  type ResolvedObservabilityOptions,
} from './tokens';

type RequestLike = {
  readonly headers: IncomingHeaders;
  id?: string;
};

type ResponseLike = {
  setHeader?(name: string, value: string): unknown;
};

/**
 * Opens the request context for every incoming call.
 *
 * Registered for every route by `NovaObservabilityModule`, so no controller has
 * to remember to read the correlation headers - which is how a service ends up
 * with three ways of doing it and one route that does none.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly context: RequestContextService,
    @Inject(OBSERVABILITY_OPTIONS)
    private readonly options: ResolvedObservabilityOptions,
  ) {}

  use(request: RequestLike, response: ResponseLike, next: () => void): void {
    const context = buildRequestContext(
      request.headers,
      this.options.correlationHeaders,
      this.options.generateId,
      // Si pino-http corrió primero, ya hay un `req.id`: se adopta en vez de
      // generar otro. Dos ids para una misma petición es lo mismo que ninguno,
      // porque la traza se corta justo donde alguien la va a buscar.
      request.id,
      this.options.requestId.accept,
    );

    // `req.id` es la convención que leen pino-http y el filtro de excepciones
    // de la plataforma. Sin esto el contexto tiene el id pero la línea de log
    // de un 5xx sale con `traceId: undefined`, que es justo la línea desde la
    // que alguien va a querer seguir la traza.
    request.id = context.requestId;

    // Con el nombre del borde, no con el de adentro: el llamador lo recibe como
    // lo mandó, aunque hacia los upstreams viaje con otro.
    if (this.options.echoRequestId) {
      response.setHeader?.(this.options.requestId.echo, context.requestId);
    }

    this.context.run(context, next);
  }
}
