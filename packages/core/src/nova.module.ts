import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  ApiStandardModule,
  type ApiStandardModuleOptions,
  type NovaErrorsOptions,
} from './api';
import { NovaAuthModule, type NovaAuthModuleOptions } from './auth';
import { NovaConfigModule, type NovaConfigModuleOptions } from './config';
import { NovaHealthModule, type NovaHealthModuleOptions } from './health';
import {
  NovaHttpModule,
  OUTBOUND_HEADERS_PROVIDER,
  type NovaHttpModuleOptions,
} from './http';
import {
  NovaObservabilityModule,
  RequestContextService,
  type NovaObservabilityModuleOptions,
} from './observability';
import { NOVA_PROFILE, mergeOptions, type NovaProfile } from './profile';

export type NovaModuleOptions = {
  /**
   * Las convenciones de la organización, declaradas una vez en su paquete
   * (ADR-036). Todo lo que el servicio declara abajo las pisa.
   *
   * Hay que pasarle el mismo perfil a `bootstrap()`: los secretos se desdoblan
   * antes de que exista la aplicación, así que el arranque no puede leerlo de
   * acá. Si no coinciden, `bootstrap()` corta el arranque.
   */
  readonly profile?: NovaProfile;

  /** Configuration and the upstreams to load. Omit to configure it yourself. */
  readonly config?: NovaConfigModuleOptions;

  /** Response envelope and global exception filter. */
  readonly apiStandard?: ApiStandardModuleOptions;

  /**
   * Los puertos del módulo de errores (ADR-031): el catálogo de códigos y
   * mensajes, el status de cada capa y tipo, y el cuerpo de la respuesta de un
   * error. El que no se declara queda con el del estándar activo o, si no trae
   * uno, con el de Nova; un perfil de organización trae los suyos.
   *
   * Es lo mismo que `apiStandard.errors`; si están los dos, gana éste.
   *
   * @example
   * NovaModule.forRoot({ errors: { catalog: organizationCatalog } });
   */
  readonly errors?: NovaErrorsOptions;

  /** Request context and correlation headers. */
  readonly observability?: NovaObservabilityModuleOptions;

  /** Outbound HTTP client. */
  readonly http?: NovaHttpModuleOptions;

  /** Liveness and readiness probes. */
  readonly health?: NovaHealthModuleOptions;

  /**
   * Autenticación por JWT. Omitir la deja apagada: un servicio interno no la
   * necesita, y declararla pone el guard sobre todas las rutas.
   */
  readonly auth?: NovaAuthModuleOptions;
};

/**
 * Everything a Nova service gets, in one import.
 *
 * Spring Boot activates a starter by finding it on the classpath. NestJS has no
 * classpath scan, so this call is the activation: it is the whole surface where
 * the platform's behaviour gets turned on.
 *
 * The part no application should have to write itself is the last binding here.
 * `nestjs-http` declares that it wants outbound headers from somewhere, and
 * `nestjs-observability` knows what the current request is. Neither imports the
 * other - this module is where they meet, which is what keeps the two usable on
 * their own.
 *
 * @example
 * @Module({
 *   imports: [
 *     NovaModule.forRoot({
 *       config: { load: [academicOrchestrator] },
 *       health: { readinessChecks: [databaseCheck] },
 *     }),
 *     CoursesModule,
 *   ],
 * })
 * export class AppModule {}
 */
@Module({})
export class NovaModule {
  static forRoot(options: NovaModuleOptions = {}): DynamicModule {
    const { profile } = options;

    // Los puertos de errores salen del perfil y del servicio, puerto por
    // puerto, y `errors` gana sobre `apiStandard.errors`: es la opción que
    // documenta ADR-031, y la otra existe sólo porque es donde vive el módulo.
    const apiStandard = mergeOptions(profile?.apiStandard, options.apiStandard);
    const errors = mergeOptions(profile?.errors, options.errors);

    const imports: DynamicModule['imports'] = [
      ApiStandardModule.forRoot(
        errors === undefined
          ? apiStandard
          : {
              ...apiStandard,
              errors: mergeOptions(apiStandard?.errors, errors),
            },
      ),
      NovaObservabilityModule.forRoot(
        mergeOptions(profile?.observability, options.observability),
      ),
      NovaHttpModule.forRoot(mergeOptions(profile?.http, options.http)),
      NovaHealthModule.forRoot(mergeOptions(profile?.health, options.health)),
    ];

    if (options.config) {
      imports.unshift(NovaConfigModule.forRoot(options.config));
    }

    // Sólo si la aplicación la declara: el guard es global, así que activarla
    // por defecto dejaría en 401 a todo servicio que no manda un token. El
    // perfil aporta cómo se lee el token, pero no decide si se pide.
    if (options.auth) {
      imports.push(
        NovaAuthModule.forRoot(
          mergeOptions(profile?.auth, options.auth) ?? options.auth,
        ),
      );
    }

    const providers: Provider[] = [
      // The binding that makes a correlation id travel with no call site
      // passing it: the client asks its port for headers, and the port is the
      // context of the request in flight.
      {
        provide: OUTBOUND_HEADERS_PROVIDER,
        useExisting: RequestContextService,
      },
      // Lo lee `bootstrap()` para comprobar que recibió el mismo perfil.
      { provide: NOVA_PROFILE, useValue: profile?.name ?? null },
    ];

    return {
      module: NovaModule,
      global: true,
      imports,
      providers,
      // Only the bindings this module owns. The four sub-modules declare
      // themselves global, so what they export is already visible everywhere
      // and re-exporting it here would add nothing - and `exports` cannot
      // carry the configuration module anyway, which resolves as a promise.
      exports: [OUTBOUND_HEADERS_PROVIDER, NOVA_PROFILE],
    };
  }
}
