import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Lo que se guarda de verdad por cada petición.
 *
 * Igual que un `RequestContext` salvo que sus cabeceras se pueden escribir, que
 * es lo que permite a `RequestContextService.enrich` agregar lo que se sabe
 * después de abrir el contexto. La forma pública sigue siendo de sólo lectura.
 */
export type StoredRequestContext = {
  readonly requestId: string;
  readonly headers: Record<string, string>;
};

/**
 * El contexto de la petición en vuelo, uno por proceso.
 *
 * Vive fuera de `RequestContextService` para que lo pueda leer código que no
 * pasa por la inyección de Nest: un error de Nova toma su `traceId` de acá en el
 * momento de construirse (ADR-031), y el módulo de errores no importa Nest.
 * Abrirlo y enriquecerlo sigue siendo trabajo del servicio y del middleware;
 * este archivo no se exporta desde el paquete.
 *
 * Que sea uno solo no mezcla peticiones: `AsyncLocalStorage` guarda un valor
 * por cadena asíncrona, no por instancia, así que dos peticiones concurrentes
 * siguen viendo cada una el suyo.
 */
export const requestContextStorage =
  new AsyncLocalStorage<StoredRequestContext>();

/**
 * El id de la petición en vuelo, o `undefined` fuera de una: un job programado
 * o un consumidor de cola, donde no hay llamada entrante con la cual
 * correlacionar.
 *
 * No lanza nunca. Se lee mientras se construye un error, y fallar ahí
 * reemplazaría el error que se estaba por lanzar.
 */
export function currentRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
