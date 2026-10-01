import {
  API_STANDARD_OPTIONS,
  ApiStandardModule,
  ERROR_PORTS,
  type ResolvedApiStandardOptions,
} from './api';
import { NovaAuthModule } from './auth';
import {
  NovaErrorStatusMapper,
  type ErrorCatalog,
  type ErrorPorts,
} from './errors';
import { OUTBOUND_HEADERS_PROVIDER } from './http';
import { RequestContextService } from './observability';
import { NovaModule } from './nova.module';
import { NOVA_PROFILE } from './profile';

type ExistingProvider = { provide: unknown; useExisting?: unknown };

function providersOf(module: { providers?: unknown[] }): ExistingProvider[] {
  return (module.providers ?? []) as ExistingProvider[];
}

describe('NovaModule.forRoot', () => {
  it('composes the four always-on modules', () => {
    const module = NovaModule.forRoot();

    expect(module.imports).toHaveLength(4);
  });

  // This is the binding no application should have to write: nestjs-http asks
  // its port for outbound headers, and the port is the request context.
  it('binds the outbound headers port to the request context', () => {
    const binding = providersOf(NovaModule.forRoot()).find(
      (provider) => provider.provide === OUTBOUND_HEADERS_PROVIDER,
    );

    expect(binding?.useExisting).toBe(RequestContextService);
  });

  it('adds the configuration module only when asked', () => {
    expect(NovaModule.forRoot().imports).toHaveLength(4);
    expect(NovaModule.forRoot({ config: { load: [] } }).imports).toHaveLength(
      5,
    );
  });

  // El guard es global: activarlo por defecto dejaría en 401 a todo servicio
  // interno, que es justo el que no manda ningún token.
  it('leaves authentication off unless the application declares it', () => {
    expect(NovaModule.forRoot().imports).toHaveLength(4);

    const withAuth = NovaModule.forRoot({ auth: {} });
    expect(withAuth.imports).toHaveLength(5);
    expect(
      (withAuth.imports as { module?: unknown }[]).some(
        (imported) => imported.module === NovaAuthModule,
      ),
    ).toBe(true);
  });

  // Only the bindings this module owns: the sub-modules are global, so what
  // they export is already visible everywhere. El perfil se exporta porque lo
  // lee `bootstrap()`.
  it('exports the headers port and the profile', () => {
    expect(NovaModule.forRoot().exports).toEqual([
      OUTBOUND_HEADERS_PROVIDER,
      NOVA_PROFILE,
    ]);
  });

  // Global, so a feature module injects the client or the context without
  // importing the platform again in every one of them.
  it('is global', () => {
    expect(NovaModule.forRoot().global).toBe(true);
  });
});

describe('the errors option of NovaModule.forRoot', () => {
  type ImportedModule = {
    module?: unknown;
    providers?: { provide: unknown; useValue?: unknown }[];
  };

  function portsOf(module: ReturnType<typeof NovaModule.forRoot>): ErrorPorts {
    const apiStandard = (module.imports as ImportedModule[]).find(
      (imported) => imported.module === ApiStandardModule,
    );

    return apiStandard?.providers?.find(
      (provider) => provider.provide === ERROR_PORTS,
    )?.useValue as ErrorPorts;
  }

  function optionsOf(
    module: ReturnType<typeof NovaModule.forRoot>,
  ): ResolvedApiStandardOptions | undefined {
    const apiStandard = (module.imports as ImportedModule[]).find(
      (imported) => imported.module === ApiStandardModule,
    );

    return apiStandard?.providers?.find(
      (provider) => provider.provide === API_STANDARD_OPTIONS,
    )?.useValue as ResolvedApiStandardOptions | undefined;
  }

  const catalog: ErrorCatalog = {
    describe: () => ({ code: 'OWN', message: 'own' }),
  };

  it('reaches the exception filter of the envelope', () => {
    expect(portsOf(NovaModule.forRoot({ errors: { catalog } })).catalog).toBe(
      catalog,
    );
  });

  // El catálogo y el serializador que no se declaran los pone el estándar activo,
  // que a veces trae los suyos: el filtro decide, no este módulo.
  it('completes only the status mapper when nothing is declared', () => {
    const ports = portsOf(NovaModule.forRoot());

    expect(ports.statusMapper).toBeInstanceOf(NovaErrorStatusMapper);
    expect(ports.catalog).toBeUndefined();
    expect(ports.serializer).toBeUndefined();
  });

  // Declararlo no se lleva lo demás de `apiStandard`.
  it('keeps the rest of the envelope options', () => {
    const module = NovaModule.forRoot({
      apiStandard: { internalErrorMessage: 'Algo falló de nuestro lado' },
      errors: {},
    });

    expect(optionsOf(module)?.internalErrorMessage).toBe(
      'Algo falló de nuestro lado',
    );
  });
});
