import { buildCorsOptions } from './cors';

describe('buildCorsOptions', () => {
  it('splits and trims the configured origins', () => {
    const options = buildCorsOptions({
      origins: 'https://nova.example.edu , https://qa.nova.example.edu',
    });

    expect(options.origin).toEqual([
      'https://nova.example.edu',
      'https://qa.nova.example.edu',
    ]);
  });

  // A container nobody configured must reject every browser origin rather than
  // accept all of them.
  it('allows nothing when the list is empty', () => {
    expect(buildCorsOptions({ origins: '' }).origin).toEqual([]);
    expect(buildCorsOptions({ origins: '  ,  ' }).origin).toEqual([]);
  });

  // Credentials plus a reflected origin is the combination that leaks a
  // session, and auth here travels in the Authorization header.
  it('never enables credentials', () => {
    expect(
      buildCorsOptions({ origins: 'https://nova.example.edu' }).credentials,
    ).toBe(false);
  });

  it('allows the correlation header by default', () => {
    const options = buildCorsOptions({ origins: 'https://nova.example.edu' });

    expect(options.allowedHeaders).toEqual([
      'Content-Type',
      'Authorization',
      'x-request-id',
    ]);
    expect(options.exposedHeaders).toEqual(['x-request-id']);
  });

  it('appends the extra headers a service declares', () => {
    const options = buildCorsOptions({
      origins: 'https://nova.example.edu',
      allowedHeaders: ['x-tenant-id'],
      exposedHeaders: ['x-request-id', 'x-total-count'],
    });

    expect(options.allowedHeaders).toContain('Authorization');
    expect(options.allowedHeaders).toContain('x-tenant-id');
    expect(options.exposedHeaders).toEqual(['x-request-id', 'x-total-count']);
  });

  // Un borde que recibe el id con su propio nombre no sirve si el navegador no
  // puede mandarlo, ni si el script no puede leer el que vuelve (ADR-037).
  it('lets the browser send and read the edge request id headers', () => {
    const options = buildCorsOptions(
      { origins: 'https://nova.example.edu' },
      { accept: ['transaction-id', 'x-request-id'], echo: 'transaction-id' },
    );

    expect(options.allowedHeaders).toEqual([
      'Content-Type',
      'Authorization',
      'x-request-id',
      'transaction-id',
    ]);
    expect(options.exposedHeaders).toEqual(['transaction-id']);
  });

  it('exposes the echoed header next to the ones a service declares', () => {
    const options = buildCorsOptions(
      {
        origins: 'https://nova.example.edu',
        exposedHeaders: ['x-total-count'],
      },
      { accept: ['x-request-id'], echo: 'x-request-id' },
    );

    expect(options.exposedHeaders).toEqual(['x-request-id', 'x-total-count']);
  });

  it('lists a header once however many times it is declared', () => {
    const options = buildCorsOptions(
      { origins: '', allowedHeaders: ['X-Request-Id', 'transaction-id'] },
      { accept: ['transaction-id'], echo: 'transaction-id' },
    );

    expect(options.allowedHeaders).toEqual([
      'Content-Type',
      'Authorization',
      'x-request-id',
      'transaction-id',
    ]);
  });

  // Without it the preflight repeats on every single request, because
  // Authorization is not a simple header.
  it('caches the preflight for a day by default', () => {
    expect(buildCorsOptions({ origins: '' }).maxAge).toBe(86400);
    expect(buildCorsOptions({ origins: '', maxAgeSeconds: 600 }).maxAge).toBe(
      600,
    );
  });
});
