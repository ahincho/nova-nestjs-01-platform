import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_STANDARD } from '../api';
import { NovaEnvelopeStandard, type ApiStandard } from '../api-standard';
import { applyApiStandard } from './api-standard-document';

/**
 * El estándar con el que contesta la aplicación.
 *
 * Sin `ApiStandardModule` no hay ninguno registrado, y se documenta el sobre de
 * Nova, que es lo que este módulo documentó siempre.
 */
function activeStandard(app: INestApplication): ApiStandard {
  try {
    return app.get<ApiStandard>(API_STANDARD, { strict: false });
  } catch {
    return new NovaEnvelopeStandard();
  }
}

/** Un servidor donde esta API responde, tal como se lista en el documento. */
export type OpenApiServer = {
  readonly url: string;
  readonly description?: string;
};

/** Un grupo de operaciones, para que la interfaz no las liste todas juntas. */
export type OpenApiTag = {
  readonly name: string;
  readonly description?: string;
};

export type OpenApiOptions = {
  /** Título del documento. Es lo único obligatorio. */
  readonly title: string;

  /** Qué hace este servicio. Se muestra arriba de todo. */
  readonly description?: string;

  /** Versión de la API, no la del paquete. Por defecto `1.0.0`. */
  readonly version?: string;

  /**
   * Dónde se sirve la interfaz. Por defecto `docs`, y el documento JSON queda
   * en `<path>/json`.
   */
  readonly path?: string;

  /**
   * Permite apagarla sin sacar el bloque entero, que es lo que hace falta para
   * decidirlo por ambiente:
   *
   *     enabled: process.env['NODE_ENV'] !== 'production'
   */
  readonly enabled?: boolean;

  /**
   * Declara el esquema `bearer` y lo aplica a todas las operaciones. Por
   * defecto true, que es lo que corresponde cuando `NovaModule` tiene `auth`:
   * ese guard es global, así que la excepción es la ruta pública y no la
   * protegida.
   */
  readonly bearerAuth?: boolean;

  /**
   * Sirve la documentación debajo del `globalPrefix`. Por defecto false: la
   * documentación no es parte de la API versionada, y dejarla en la raíz evita
   * que cambiar el prefijo mueva su URL.
   */
  readonly useGlobalPrefix?: boolean;

  readonly servers?: readonly OpenApiServer[];
  readonly tags?: readonly OpenApiTag[];
};

export const DEFAULT_OPENAPI_PATH = 'docs';

/** El nombre del esquema de seguridad, tal como lo referencia el documento. */
export const BEARER_SCHEME = 'bearer';

/**
 * Monta el documento OpenAPI y su interfaz.
 *
 * Normalmente no se llama a mano: `bootstrap()` lo hace cuando recibe la opción
 * `openapi`. Está exportada para el servicio que arma su aplicación por su
 * cuenta.
 */
export function setupOpenApi(
  app: INestApplication,
  options: OpenApiOptions,
): void {
  const builder = new DocumentBuilder()
    .setTitle(options.title)
    .setVersion(options.version ?? '1.0.0');

  if (options.description !== undefined) {
    builder.setDescription(options.description);
  }

  if (options.bearerAuth ?? true) {
    builder.addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      BEARER_SCHEME,
    );
  }

  for (const server of options.servers ?? []) {
    builder.addServer(server.url, server.description);
  }

  for (const tag of options.tags ?? []) {
    builder.addTag(tag.name, tag.description);
  }

  // Los esquemas del cuerpo los pone el estándar activo, no los decoradores:
  // los decoradores corren antes de que exista la inyección y sólo pueden
  // escribir el sobre de Nova. Acá sí se sabe cuál está activo.
  //
  // Eso incluye los componentes que ningún controlador alcanza -nadie devuelve
  // ni recibe el sobre como tipo-, que sin esto dejarían el documento con
  // referencias a esquemas que no existen.
  const document = applyApiStandard(
    SwaggerModule.createDocument(app, builder.build()),
    activeStandard(app),
  );

  // El requisito va en la raíz y no operación por operación porque el guard de
  // `NovaAuthModule` también es global. Declararlo con un decorador en cada
  // método invertiría el default: se documentaría como abierto todo lo que
  // alguien olvidó anotar, que es exactamente al revés de como se comporta.
  if (options.bearerAuth ?? true) {
    document.security = [{ [BEARER_SCHEME]: [] }];
  }

  const path = options.path ?? DEFAULT_OPENAPI_PATH;

  SwaggerModule.setup(path, app, document, {
    useGlobalPrefix: options.useGlobalPrefix ?? false,
    jsonDocumentUrl: `${path}/json`,
  });
}
