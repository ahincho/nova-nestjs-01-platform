import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiStandardModule } from './api-standard.module';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { ResponseWrapperInterceptor } from './interceptors/response-wrapper.interceptor';
import {
  Layer,
  NovaErrorCatalog,
  NovaErrorSerializer,
  NovaErrorStatusMapper,
  type ErrorCatalog,
  type ErrorPorts,
} from '../errors';
import {
  API_STANDARD_OPTIONS,
  DEFAULT_API_STANDARD_OPTIONS,
  ERROR_PORTS,
} from './tokens';

type ClassProvider = {
  provide: unknown;
  useClass?: unknown;
  useValue?: unknown;
};

function providersOf(module: { providers?: unknown[] }): ClassProvider[] {
  return (module.providers ?? []) as ClassProvider[];
}

function findByToken(
  module: { providers?: unknown[] },
  token: unknown,
): ClassProvider | undefined {
  return providersOf(module).find((provider) => provider.provide === token);
}

describe('ApiStandardModule.forRoot', () => {
  it('registers the interceptor, the filter and the resolved options', () => {
    const module = ApiStandardModule.forRoot();

    expect(findByToken(module, APP_INTERCEPTOR)?.useClass).toBe(
      ResponseWrapperInterceptor,
    );
    expect(findByToken(module, APP_FILTER)?.useClass).toBe(AllExceptionsFilter);
    expect(findByToken(module, API_STANDARD_OPTIONS)?.useValue).toEqual(
      DEFAULT_API_STANDARD_OPTIONS,
    );
  });

  // The options provider stays even when both features are off, because other
  // Nova packages read the internal error message from it.
  it('omits the interceptor when response wrapping is off', () => {
    const module = ApiStandardModule.forRoot({ wrapResponses: false });

    expect(findByToken(module, APP_INTERCEPTOR)).toBeUndefined();
    expect(findByToken(module, APP_FILTER)).toBeDefined();
    expect(findByToken(module, API_STANDARD_OPTIONS)).toBeDefined();
  });

  it('omits the filter when exception catching is off', () => {
    const module = ApiStandardModule.forRoot({ catchExceptions: false });

    expect(findByToken(module, APP_FILTER)).toBeUndefined();
    expect(findByToken(module, APP_INTERCEPTOR)).toBeDefined();
  });

  // Global, so a feature module can inject the options without importing this
  // module again - the same reason Nest marks ConfigModule global.
  it('is a global module exporting its options and error ports tokens', () => {
    const module = ApiStandardModule.forRoot();

    expect(module.global).toBe(true);
    expect(module.exports).toEqual([API_STANDARD_OPTIONS, ERROR_PORTS]);
  });
});

describe('the error ports of ApiStandardModule.forRoot', () => {
  function portsOf(module: { providers?: unknown[] }): ErrorPorts {
    return findByToken(module, ERROR_PORTS)?.useValue as ErrorPorts;
  }

  it('falls back to the three Nova implementations', () => {
    const ports = portsOf(ApiStandardModule.forRoot());

    expect(ports.catalog).toBeInstanceOf(NovaErrorCatalog);
    expect(ports.statusMapper).toBeInstanceOf(NovaErrorStatusMapper);
    expect(ports.serializer).toBeInstanceOf(NovaErrorSerializer);
  });

  // Reemplazar uno no se lleva a los otros dos: un perfil que sólo trae su
  // catálogo sigue contestando con el sobre y la tabla de Nova.
  it('replaces only the port that is declared', () => {
    const catalog: ErrorCatalog = {
      describe: () => ({ code: 'OWN', message: 'own' }),
    };

    const ports = portsOf(ApiStandardModule.forRoot({ errors: { catalog } }));

    expect(ports.catalog).toBe(catalog);
    expect(ports.statusMapper).toBeInstanceOf(NovaErrorStatusMapper);
    expect(ports.serializer).toBeInstanceOf(NovaErrorSerializer);
  });

  it('builds the Nova catalog with the configured internal message', () => {
    const ports = portsOf(
      ApiStandardModule.forRoot({
        internalErrorMessage: 'Error interno del servidor',
      }),
    );

    expect(
      ports.catalog.describe(
        { layer: Layer.PLATFORM, message: 'boom', fieldErrors: [] },
        500,
      ).message,
    ).toBe('Error interno del servidor');
  });

  // Las opciones resueltas no cargan los puertos: viven bajo su propio token.
  it('keeps the ports out of the resolved options', () => {
    const module = ApiStandardModule.forRoot({ errors: {} });

    expect(findByToken(module, API_STANDARD_OPTIONS)?.useValue).toEqual(
      DEFAULT_API_STANDARD_OPTIONS,
    );
  });
});
