import { fetch } from 'undici';
import { NovaHttpAgent } from './http-agent';
import { HttpClientService } from './http-client.service';
import { NovaHttpModule } from './nova-http.module';
import {
  DEFAULT_HTTP_POOL,
  DEFAULT_HTTP_TIMEOUT_MS,
  NOVA_HTTP_OPTIONS,
  NOVA_HTTP_TRANSPORT,
  resolveNovaHttpOptions,
} from './tokens';

type ValueProvider = { provide: unknown; useValue?: unknown };

describe('resolveNovaHttpOptions', () => {
  it('applies the defaults', () => {
    expect(resolveNovaHttpOptions()).toEqual({
      defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      defaultHeaders: {},
      pool: DEFAULT_HTTP_POOL,
    });
  });

  it('keeps the default when a field is explicitly undefined', () => {
    expect(
      resolveNovaHttpOptions({ defaultTimeoutMs: undefined }).defaultTimeoutMs,
    ).toBe(DEFAULT_HTTP_TIMEOUT_MS);
  });

  it('honours a configured timeout', () => {
    expect(
      resolveNovaHttpOptions({ defaultTimeoutMs: 1200 }).defaultTimeoutMs,
    ).toBe(1200);
  });

  // El pool viene encendido: un servicio que no dice nada igual reusa
  // conexiones, que es lo que hacía a mano el código que esto reemplaza.
  it('turns the pool on by default and keeps the fields not overridden', () => {
    expect(resolveNovaHttpOptions({ pool: { connections: 100 } }).pool).toEqual(
      {
        ...DEFAULT_HTTP_POOL,
        connections: 100,
      },
    );
  });

  it('lets a service turn the pool off', () => {
    expect(resolveNovaHttpOptions({ pool: false }).pool).toBe(false);
  });
});

describe('NovaHttpModule.forRoot', () => {
  it('provides the client, the agent and its resolved options', () => {
    const module = NovaHttpModule.forRoot({ defaultTimeoutMs: 2000 });
    const providers = (module.providers ?? []) as ValueProvider[];

    expect(providers).toContain(HttpClientService);
    expect(providers).toContain(NovaHttpAgent);
    expect(
      providers.find((provider) => provider.provide === NOVA_HTTP_OPTIONS)
        ?.useValue,
    ).toEqual({
      defaultTimeoutMs: 2000,
      defaultHeaders: {},
      pool: DEFAULT_HTTP_POOL,
    });
  });

  // El agente se registra aunque el pool esté apagado, para que el cliente lo
  // inyecte sin condiciones y una opción no produzca dos grafos distintos.
  it('registers the agent even with the pool off', () => {
    const providers = (NovaHttpModule.forRoot({ pool: false }).providers ??
      []) as ValueProvider[];

    expect(providers).toContain(NovaHttpAgent);
  });

  // Global, so a feature module can inject the client without importing this
  // module again in every one of them.
  it('is global and exports the client', () => {
    const module = NovaHttpModule.forRoot();

    expect(module.global).toBe(true);
    expect(module.exports).toEqual([
      HttpClientService,
      NovaHttpAgent,
      NOVA_HTTP_OPTIONS,
      NOVA_HTTP_TRANSPORT,
    ]);
  });

  // El transporte es un proveedor para que una prueba lo reemplace con
  // `overrideProvider`: el cliente no usa el `fetch` global, así que
  // sustituirlo no intercepta nada.
  it('provides the undici fetch as the transport', () => {
    const providers = (NovaHttpModule.forRoot().providers ??
      []) as ValueProvider[];

    expect(
      providers.find((provider) => provider.provide === NOVA_HTTP_TRANSPORT)
        ?.useValue,
    ).toBe(fetch);
  });
});
