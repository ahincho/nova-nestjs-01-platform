import {
  DEFAULT_CORRELATION_HEADERS,
  buildRequestContext,
} from './request-context';

const generateId = () => 'generated-id';

function build(headers: Record<string, string | string[] | undefined>) {
  return buildRequestContext(headers, DEFAULT_CORRELATION_HEADERS, generateId);
}

describe('buildRequestContext', () => {
  it('keeps the correlation id the caller sent', () => {
    const context = build({ 'x-request-id': 'req-1' });

    expect(context.requestId).toBe('req-1');
    expect(context.headers).toEqual({ 'x-request-id': 'req-1' });
  });

  it('generates an id when the caller sent none', () => {
    const context = build({});

    expect(context.requestId).toBe('generated-id');
    expect(context.headers['x-request-id']).toBe('generated-id');
  });

  // Si pino-http corrió primero ya hay un `req.id`. Adoptarlo es lo que hace
  // que el contexto y el log digan lo mismo sin importar el orden de los
  // middlewares: dos ids para una petición es igual que ninguno, porque la
  // traza se corta justo donde alguien la va a buscar.
  it('adopts an id already put on the request instead of minting another', () => {
    const context = buildRequestContext(
      {},
      DEFAULT_CORRELATION_HEADERS,
      generateId,
      'from-pino',
    );

    expect(context.requestId).toBe('from-pino');
    expect(context.headers['x-request-id']).toBe('from-pino');
  });

  // No gana sobre la cabecera: si el llamador mandó un id, ese es el que hay
  // que propagar, porque es el que cita cuando reporta la falla.
  it('still prefers the id the caller sent', () => {
    const context = buildRequestContext(
      { 'x-request-id': 'req-1' },
      DEFAULT_CORRELATION_HEADERS,
      generateId,
      'from-pino',
    );

    expect(context.requestId).toBe('req-1');
  });

  it('generates one when the id already on the request is empty', () => {
    const context = buildRequestContext(
      {},
      DEFAULT_CORRELATION_HEADERS,
      generateId,
      '',
    );

    expect(context.requestId).toBe('generated-id');
  });

  // Node lowercases incoming header names, but a hand-built request or another
  // runtime does not, and a context that misses the id silently starts a new
  // trace halfway through a call.
  it('reads header names case-insensitively', () => {
    expect(build({ 'X-Request-Id': 'req-1' }).requestId).toBe('req-1');
  });

  it('carries the other correlation headers the caller sent', () => {
    const context = build({
      'x-request-id': 'req-1',
      'x-user-id': 'u-9',
      'x-tenant-id': 't-3',
    });

    expect(context.headers).toEqual({
      'x-request-id': 'req-1',
      'x-user-id': 'u-9',
      'x-tenant-id': 't-3',
    });
  });

  // An empty `x-user-id` downstream reads as "there is a user and it has no
  // id", which is worse than saying nothing.
  it('leaves out a header that is absent or empty', () => {
    const context = build({ 'x-request-id': 'req-1', 'x-user-id': '' });

    expect(context.headers).not.toHaveProperty('x-user-id');
  });

  it('takes the first value of a repeated header', () => {
    expect(build({ 'x-request-id': ['req-1', 'req-2'] }).requestId).toBe(
      'req-1',
    );
  });

  it('carries nothing but the id when the list says so', () => {
    const context = buildRequestContext(
      { 'x-correlation-id': 'c-1', 'x-user-id': 'u-9' },
      ['x-correlation-id'],
      generateId,
    );

    expect(context.headers).toEqual({ 'x-correlation-id': 'c-1' });
  });

  it('falls back to x-request-id when the list is empty', () => {
    expect(build({}).headers).toHaveProperty('x-request-id');
    expect(buildRequestContext({}, [], generateId).headers).toEqual({
      'x-request-id': 'generated-id',
    });
  });

  // Vacío es lo mismo que ausente: un id vacío correlaciona todo con todo.
  it('generates an id when the caller sent it empty', () => {
    expect(build({ 'x-request-id': '' }).requestId).toBe('generated-id');
  });
});

// El borde recibe el id con su propio nombre y hacia adentro viaja con el de
// siempre (ADR-037).
describe('buildRequestContext at the edge', () => {
  const accept = ['transaction-id', 'x-request-id'];

  function atEdge(headers: Record<string, string | undefined>) {
    return buildRequestContext(
      headers,
      ['x-request-id', 'user-id'],
      generateId,
      undefined,
      accept,
    );
  }

  it('takes the id the edge accepts and sends it on under the inner name', () => {
    const context = atEdge({ 'transaction-id': 'tx-1' });

    expect(context.requestId).toBe('tx-1');
    expect(context.headers).toEqual({ 'x-request-id': 'tx-1' });
  });

  it('prefers the accepted headers in their order', () => {
    const context = atEdge({ 'transaction-id': 'tx-1', 'x-request-id': 'r-1' });

    expect(context.requestId).toBe('tx-1');
  });

  // Así el mismo perfil sirve al borde y a los servicios de adentro, que
  // reciben el id con el nombre con que viaja.
  it('falls back to the next accepted header', () => {
    expect(atEdge({ 'x-request-id': 'r-1' }).requestId).toBe('r-1');
  });

  it('skips an accepted header that came empty', () => {
    const context = atEdge({ 'transaction-id': '', 'x-request-id': 'r-1' });

    expect(context.requestId).toBe('r-1');
  });

  it('generates an id when no accepted header came', () => {
    expect(atEdge({}).requestId).toBe('generated-id');
  });

  it('never takes the caller id when nothing is accepted', () => {
    const context = buildRequestContext(
      { 'x-request-id': 'r-1' },
      DEFAULT_CORRELATION_HEADERS,
      generateId,
      undefined,
      [],
    );

    expect(context.requestId).toBe('generated-id');
  });
});
