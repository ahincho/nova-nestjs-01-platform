import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { fetch } from 'undici';
import { NovaHttpAgent } from './http-agent';
import { HttpClientService } from './http-client.service';
import {
  NOVA_HTTP_OPTIONS,
  NOVA_HTTP_TRANSPORT,
  resolveNovaHttpOptions,
  type HttpTransport,
  type NovaHttpModuleOptions,
} from './tokens';

/**
 * Registra el cliente HTTP saliente y el pool que comparten sus llamadas.
 *
 * @example
 * @Module({
 *   imports: [
 *     NovaHttpModule.forRoot({
 *       defaultTimeoutMs: 3000,
 *       pool: { connections: 100 },
 *     }),
 *   ],
 * })
 * export class AppModule {}
 */
@Module({})
export class NovaHttpModule {
  static forRoot(options: NovaHttpModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: NOVA_HTTP_OPTIONS, useValue: resolveNovaHttpOptions(options) },
      // Se registra siempre, incluso con el pool apagado: así el cliente lo
      // inyecta sin condiciones y es el agente el que decide no tener ninguno.
      // Un proveedor que a veces existe convierte una opción en dos grafos de
      // dependencias distintos.
      NovaHttpAgent,
      // Un proveedor y no un import directo en el cliente, para que una prueba
      // lo reemplace con `overrideProvider` en vez de sustituir el módulo.
      { provide: NOVA_HTTP_TRANSPORT, useValue: fetch satisfies HttpTransport },
      HttpClientService,
    ];

    return {
      module: NovaHttpModule,
      global: true,
      providers,
      exports: [
        HttpClientService,
        NovaHttpAgent,
        NOVA_HTTP_OPTIONS,
        NOVA_HTTP_TRANSPORT,
      ],
    };
  }
}
