/**
 * What is known about the request currently being served.
 *
 * Held in an `AsyncLocalStorage`, so anything running underneath a request can
 * read it without the value being threaded through every signature - which is
 * what made every service grow its own way of passing a correlation id down.
 */
export type RequestContext = {
  /**
   * Always present: taken from the incoming header, or generated when the
   * caller did not send one.
   */
  readonly requestId: string;

  /**
   * The headers to put on every outbound call, including the request id.
   */
  readonly headers: Readonly<Record<string, string>>;
};

/**
 * Headers copied from the incoming request onto every outbound one.
 *
 * The first is the correlation id and is generated when absent; the rest travel
 * only if the caller sent them.
 */
export const DEFAULT_CORRELATION_HEADERS = [
  'x-request-id',
  'x-user-id',
  'x-tenant-id',
] as const;

export type IncomingHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Builds the context for one request.
 *
 * @param headers - the incoming headers, read case-insensitively.
 * @param correlationHeaders - which headers to carry, the first being the id.
 * @param generateId - produces an id when the caller did not send one.
 * @param existingId - un id que alguien ya puso sobre la petición, típicamente
 * el `req.id` de pino-http. Gana sobre generar uno nuevo, y por eso el contexto
 * y el log dicen lo mismo sin importar cuál de los dos middlewares corrió
 * primero. No gana sobre la cabecera: si el llamador mandó un id, ese es el que
 * hay que propagar.
 * @param accept - de qué cabeceras se toma el id del llamador, en orden. Por
 * defecto, la misma con la que viaja. El borde puede recibirlo con otro nombre
 * (ADR-037), y hacia adentro sigue viajando con el primero de
 * `correlationHeaders`.
 */
export function buildRequestContext(
  headers: IncomingHeaders,
  correlationHeaders: readonly string[],
  generateId: () => string,
  existingId?: string,
  accept?: readonly string[],
): RequestContext {
  const lowercased: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    lowercased[name.toLowerCase()] = value;
  }

  const read = (name: string): string | undefined => {
    const value = firstValue(lowercased[name.toLowerCase()]);
    // Vacío es lo mismo que ausente: un id vacío correlaciona todo con todo.
    return value === '' ? undefined : value;
  };

  const [idHeader = 'x-request-id', ...rest] = correlationHeaders;
  const adopted = existingId === '' ? undefined : existingId;
  const sent = (accept ?? [idHeader])
    .map(read)
    .find((value) => value !== undefined);
  const requestId = sent ?? adopted ?? generateId();

  const propagated: Record<string, string> = { [idHeader]: requestId };

  for (const name of rest) {
    const value = read(name);
    // Absent headers are left out rather than sent empty: an empty `x-user-id`
    // downstream reads as "there is a user and it has no id", which is worse
    // than saying nothing.
    if (value !== undefined) {
      propagated[name] = value;
    }
  }

  return { requestId, headers: propagated };
}
