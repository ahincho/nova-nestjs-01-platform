import { Injectable } from '@nestjs/common';
import type { RequestContext } from './request-context';
import { requestContextStorage } from './request-context.storage';

/**
 * Reads and carries the {@link RequestContext} of the request in flight.
 *
 * Also the implementation behind `OUTBOUND_HEADERS_PROVIDER` of
 * `@ahincho/nova-nestjs-http`: it satisfies that port structurally, so the
 * aggregator can bind the two without either package importing the other.
 */
@Injectable()
export class RequestContextService {
  // El del proceso y no uno propio de la instancia: es el mismo que lee un
  // error de Nova al construirse, sin pasar por la inyección (ADR-031).
  private readonly storage = requestContextStorage;

  /**
   * Runs `callback` with `context` visible to everything it awaits.
   */
  run<T>(context: RequestContext, callback: () => T): T {
    // Copia y no el objeto recibido: acá se escribe con `enrich`, y mutar lo
    // que armó el middleware haría que dos peticiones compartan cabeceras si
    // alguna vez pasa el mismo objeto dos veces.
    return this.storage.run(
      { requestId: context.requestId, headers: { ...context.headers } },
      callback,
    );
  }

  /**
   * The current context, or `undefined` outside a request - a scheduled job or
   * a consumer, where there is no incoming call to correlate with.
   */
  get(): RequestContext | undefined {
    return this.storage.getStore();
  }

  /**
   * The id of the request in flight, if there is one.
   */
  requestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  /**
   * Agrega cabeceras al contexto de la petición en vuelo.
   *
   * Existe para lo que se sabe después de abrir el contexto: el middleware
   * corre antes que cualquier guard, así que el identificador del usuario -que
   * sale del token- todavía no existe cuando el contexto se crea.
   *
   * Fuera de una petición no hace nada, en vez de inventar un contexto que
   * nadie va a cerrar.
   */
  enrich(headers: Readonly<Record<string, string>>): void {
    const current = this.storage.getStore();
    if (!current) {
      return;
    }
    // Se escribe sobre el objeto guardado en vez de reemplazarlo con
    // `enterWith`: eso vale sólo para la cadena síncrona que lo llama, y el
    // guard es asíncrono, así que el controlador ya no lo vería.
    Object.assign(current.headers, headers);
  }

  /**
   * Quita cabeceras del contexto de la petición en vuelo, sin distinguir
   * mayúsculas.
   *
   * Es la contracara de `enrich`: la usa la autenticación para borrar la
   * identidad que el contexto copió de la petición, que sólo ella puede
   * escribir (ADR-037). Fuera de una petición no hace nada.
   */
  remove(names: readonly string[]): void {
    const current = this.storage.getStore();
    if (!current) {
      return;
    }
    const unwanted = new Set(names.map((name) => name.toLowerCase()));
    // Sobre el objeto guardado, por lo mismo que `enrich`.
    for (const name of Object.keys(current.headers)) {
      if (unwanted.has(name.toLowerCase())) {
        delete current.headers[name];
      }
    }
  }

  /**
   * The headers every outbound call should carry.
   *
   * Empty outside a request, so a background job calls upstreams without
   * inventing a correlation that does not exist.
   */
  headers(): Record<string, string> {
    return { ...(this.storage.getStore()?.headers ?? {}) };
  }
}
