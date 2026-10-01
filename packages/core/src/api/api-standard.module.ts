import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { NovaEnvelopeStandard } from '../api-standard';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { ResponseWrapperInterceptor } from './interceptors/response-wrapper.interceptor';
import {
  API_STANDARD,
  API_STANDARD_OPTIONS,
  ERROR_PORTS,
  resolveApiStandardOptions,
  resolveErrorPorts,
  type ApiStandardModuleOptions,
} from './tokens';

/**
 * El proveedor del estándar activo.
 *
 * Una clase se registra con `useClass` para que la inyección le resuelva sus
 * dependencias; una instancia, tal cual. Omitirlo registra el sobre de Nova, que
 * es lo que hace que un servicio que no declara nada conteste igual que antes.
 */
function standardProvider(
  standard: ApiStandardModuleOptions['standard'],
): Provider {
  if (standard === undefined) {
    return { provide: API_STANDARD, useValue: new NovaEnvelopeStandard() };
  }

  // Una clase es una función; una instancia, no. No hay un tercer caso.
  return typeof standard === 'function'
    ? { provide: API_STANDARD, useClass: standard }
    : { provide: API_STANDARD, useValue: standard };
}

/**
 * Registers the API standard across the application: the shape of every
 * response, and of every rejected input.
 *
 * Unlike a Spring Boot starter, nothing here activates by being on the
 * classpath: NestJS has no classpath scan, so the module has to be imported and
 * `forRoot()` called. That call is the whole activation surface.
 *
 * @example
 * @Module({
 *   imports: [ApiStandardModule.forRoot()],
 * })
 * export class AppModule {}
 */
@Module({})
export class ApiStandardModule {
  static forRoot(options: ApiStandardModuleOptions = {}): DynamicModule {
    const resolved = resolveApiStandardOptions(options);

    const providers: Provider[] = [
      { provide: API_STANDARD_OPTIONS, useValue: resolved },
      standardProvider(options.standard),
      // Los puertos quedan aunque el filtro esté apagado, igual que las
      // opciones: son la forma de los errores del servicio, y quien los contesta
      // por su cuenta -un filtro para otro transporte- los inyecta en vez de
      // inventar otra.
      {
        provide: ERROR_PORTS,
        useValue: resolveErrorPorts(options.errors),
      },
    ];

    if (resolved.wrapResponses) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: ResponseWrapperInterceptor,
      });
    }

    if (resolved.catchExceptions) {
      providers.push({ provide: APP_FILTER, useClass: AllExceptionsFilter });
    }

    return {
      module: ApiStandardModule,
      global: true,
      providers,
      // El estándar se exporta porque el documento OpenAPI tiene que describir
      // el que está activo, y lo arma `setupOpenApi` fuera de este módulo.
      exports: [API_STANDARD_OPTIONS, API_STANDARD, ERROR_PORTS],
    };
  }
}
