import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { ResponseWrapperInterceptor } from './interceptors/response-wrapper.interceptor';
import {
  API_STANDARD_OPTIONS,
  ERROR_PORTS,
  resolveApiStandardOptions,
  resolveErrorPorts,
  type ApiStandardModuleOptions,
} from './tokens';

/**
 * Registers the response envelope across the application.
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
      // Los puertos quedan aunque el filtro esté apagado, igual que las
      // opciones: son la forma de los errores del servicio, y quien los contesta
      // por su cuenta -un filtro para otro transporte- los inyecta en vez de
      // inventar otra.
      {
        provide: ERROR_PORTS,
        useValue: resolveErrorPorts(
          options.errors,
          resolved.internalErrorMessage,
        ),
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
      exports: [API_STANDARD_OPTIONS, ERROR_PORTS],
    };
  }
}
