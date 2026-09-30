import { ApiStandardModule, ERROR_PORTS } from './api';
import { NovaAuthModule } from './auth';
import {
  Layer,
  NovaErrorCatalog,
  type ErrorCatalog,
  type ErrorPorts,
} from './errors';
import { OUTBOUND_HEADERS_PROVIDER } from './http';
import { RequestContextService } from './observability';
import { NovaModule } from './nova.module';

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

  // Only the binding this module owns: the sub-modules are global, so what
  // they export is already visible everywhere.
  it('exports the headers port', () => {
    expect(NovaModule.forRoot().exports).toEqual([OUTBOUND_HEADERS_PROVIDER]);
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

  const catalog: ErrorCatalog = {
    describe: () => ({ code: 'OWN', message: 'own' }),
  };

  it('reaches the exception filter of the envelope', () => {
    expect(portsOf(NovaModule.forRoot({ errors: { catalog } })).catalog).toBe(
      catalog,
    );
  });

  it('leaves the Nova ports when it is not declared', () => {
    expect(portsOf(NovaModule.forRoot()).catalog).toBeInstanceOf(
      NovaErrorCatalog,
    );
  });

  // Declararlo no se lleva lo demás de `apiStandard`.
  it('keeps the rest of the envelope options', () => {
    const module = NovaModule.forRoot({
      apiStandard: { internalErrorMessage: 'Error interno del servidor' },
      errors: {},
    });

    expect(
      portsOf(module).catalog.describe(
        { layer: Layer.PLATFORM, message: 'boom', fieldErrors: [] },
        500,
      ).message,
    ).toBe('Error interno del servidor');
  });
});
