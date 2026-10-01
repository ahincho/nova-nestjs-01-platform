import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { createRequestLoggerOptions } from './logger';
import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';
import {
  OBSERVABILITY_OPTIONS,
  resolveObservabilityOptions,
  type NovaObservabilityModuleOptions,
} from './tokens';

/**
 * Abre el contexto de cada petición, lo expone para leerlo y monta el logger
 * estructurado.
 *
 * El logger va acá y no en el `main.ts` de cada servicio porque el formato del
 * documento de log es un contrato con quien lo recolecta e indexa: los campos
 * `req.id`, `context`, `level` y `err` son por los que alguien filtra a las tres
 * de la mañana. Un servicio que arma el suyo produce líneas que llegan al índice
 * y no aparecen en ninguna consulta guardada.
 *
 * @example
 * @Module({
 *   imports: [NovaObservabilityModule.forRoot()],
 * })
 * export class AppModule {}
 */
@Module({})
export class NovaObservabilityModule implements NestModule {
  static forRoot(options: NovaObservabilityModuleOptions = {}): DynamicModule {
    const resolved = resolveObservabilityOptions(options);

    const providers: Provider[] = [
      { provide: OBSERVABILITY_OPTIONS, useValue: resolved },
      RequestContextService,
    ];

    const imports: DynamicModule['imports'] = [];
    const exports: DynamicModule['exports'] = [
      RequestContextService,
      OBSERVABILITY_OPTIONS,
    ];

    if (resolved.logger !== false) {
      // Las cabeceras del id no se declaran dos veces: el log lee las mismas de
      // las que lo toma el contexto, en el mismo orden, así que cambiarlas mueve
      // el contexto y el log juntos.
      const loggerModule = LoggerModule.forRoot(
        createRequestLoggerOptions({
          requestIdHeader: resolved.requestId.accept,
          ...resolved.logger,
        }),
      );

      imports.push(loggerModule);
      // Se reexporta para que el `Logger` de nestjs-pino se pueda inyectar desde
      // cualquier módulo, y para que `bootstrap()` lo resuelva sin que el
      // servicio importe nada.
      exports.push(loggerModule);
    }

    return {
      module: NovaObservabilityModule,
      global: true,
      imports,
      providers,
      exports,
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Every route, including the health probes: a probe that fails is exactly
    // the log line someone will want to correlate.
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
