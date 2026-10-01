import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';
import { resolveObservabilityOptions } from './tokens';

describe('RequestContextMiddleware', () => {
  let service: RequestContextService;

  beforeEach(() => {
    service = new RequestContextService();
  });

  function middleware(
    options: Parameters<typeof resolveObservabilityOptions>[0] = {},
  ): RequestContextMiddleware {
    return new RequestContextMiddleware(
      service,
      resolveObservabilityOptions({
        generateId: () => 'generated-id',
        ...options,
      }),
    );
  }

  it('opens the context for the rest of the chain', () => {
    const next = vi.fn(() => {
      expect(service.requestId()).toBe('req-1');
    });

    middleware().use(
      { headers: { 'x-request-id': 'req-1' } },
      { setHeader: vi.fn() },
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  // `req.id` is what pino-http and the platform's exception filter read. Without
  // it the context holds the id but a 5xx log line says `requestId: undefined`,
  // which is exactly the line someone will want to follow the trace from.
  it('stamps the id on the request under the convention others read', () => {
    const request: { headers: Record<string, string>; id?: string } = {
      headers: { 'x-request-id': 'req-1' },
    };

    middleware().use(request, { setHeader: vi.fn() }, vi.fn());

    expect(request.id).toBe('req-1');
  });

  it('stamps a generated id too', () => {
    const request: { headers: Record<string, string>; id?: string } = {
      headers: {},
    };

    middleware().use(request, { setHeader: vi.fn() }, vi.fn());

    expect(request.id).toBe('generated-id');
  });

  // The caller needs the id to report a failure, and a browser can only read it
  // because the CORS policy exposes that header.
  it('echoes the correlation id back on the response', () => {
    const setHeader = vi.fn();

    middleware().use({ headers: {} }, { setHeader }, vi.fn());

    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'generated-id');
  });

  it('can be told not to echo it', () => {
    const setHeader = vi.fn();

    middleware({ echoRequestId: false }).use(
      { headers: {} },
      { setHeader },
      vi.fn(),
    );

    expect(setHeader).not.toHaveBeenCalled();
  });

  // A platform whose response object has no setHeader must not take the
  // request down over an echo that is a convenience.
  it('still serves when the response cannot take headers', () => {
    const next = vi.fn();

    expect(() => middleware().use({ headers: {} }, {}, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('echoes under the configured header name', () => {
    const setHeader = vi.fn();

    middleware({ correlationHeaders: ['x-correlation-id'] }).use(
      { headers: {} },
      { setHeader },
      vi.fn(),
    );

    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'generated-id');
  });

  // El llamador lo recibe con el nombre con que lo mandó, aunque hacia los
  // upstreams viaje con otro (ADR-037).
  it('takes the id under the edge name and echoes it under that same name', () => {
    const setHeader = vi.fn();
    const next = vi.fn(() => {
      expect(service.headers()).toEqual({ 'x-request-id': 'tx-1' });
    });

    middleware({
      requestId: { accept: ['transaction-id', 'x-request-id'] },
    }).use({ headers: { 'transaction-id': 'tx-1' } }, { setHeader }, next);

    expect(setHeader).toHaveBeenCalledWith('transaction-id', 'tx-1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('echoes under the name it is told', () => {
    const setHeader = vi.fn();

    middleware({ requestId: { echo: 'x-trace-id' } }).use(
      { headers: {} },
      { setHeader },
      vi.fn(),
    );

    expect(setHeader).toHaveBeenCalledWith('x-trace-id', 'generated-id');
  });
});

describe('resolveObservabilityOptions', () => {
  it('applies the defaults', () => {
    const options = resolveObservabilityOptions();

    expect(options.correlationHeaders).toEqual([
      'x-request-id',
      'x-user-id',
      'x-tenant-id',
    ]);
    expect(options.echoRequestId).toBe(true);
    expect(options.generateId()).toEqual(expect.any(String));
  });

  it('keeps a default when a field is explicitly undefined', () => {
    expect(
      resolveObservabilityOptions({ echoRequestId: undefined }).echoRequestId,
    ).toBe(true);
  });

  it('generates a distinct id each time by default', () => {
    const { generateId } = resolveObservabilityOptions();

    expect(generateId()).not.toBe(generateId());
  });

  // Por defecto el id entra y sale con el mismo nombre con que viaja, que es
  // lo que hacía la plataforma antes de separarlos.
  it('takes and echoes the id under the name it travels with', () => {
    expect(resolveObservabilityOptions().requestId).toEqual({
      accept: ['x-request-id'],
      echo: 'x-request-id',
    });
    expect(
      resolveObservabilityOptions({ correlationHeaders: ['x-correlation-id'] })
        .requestId,
    ).toEqual({ accept: ['x-correlation-id'], echo: 'x-correlation-id' });
  });

  it('echoes under the first accepted header unless told otherwise', () => {
    expect(
      resolveObservabilityOptions({
        requestId: { accept: ['transaction-id', 'x-request-id'] },
      }).requestId.echo,
    ).toBe('transaction-id');
  });

  it('echoes under the travelling name when nothing is accepted', () => {
    expect(
      resolveObservabilityOptions({ requestId: { accept: [] } }).requestId,
    ).toEqual({ accept: [], echo: 'x-request-id' });
  });
});
