import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseSecretJson, type UnfoldSecretsOptions } from './secrets';

/**
 * Variable con los secretos que se piden a un almacén, separados por coma, como
 * `vault:ms-course, optional:aws-secrets-manager:prod/db`.
 *
 * Es la misma en Spring Boot y en Quarkus (ADR-049): quien opera un servicio
 * pide un almacén igual sin saber en qué framework está escrito.
 */
export const SECRET_IMPORT_VARIABLE = 'NOVA_SECRETS_IMPORT';

/** Lo que marca un secreto que puede faltar, como en `spring.config.import`. */
export const OPTIONAL_PREFIX = 'optional:';

/**
 * El paquete de cada almacén se llama así más el nombre de la fuente, como
 * `@ahincho/nova-nestjs-secrets-vault`. Es la convención que deja encontrarlo
 * sin que el servicio lo registre en el código.
 */
export const SECRET_SOURCE_PACKAGE_PREFIX = '@ahincho/nova-nestjs-secrets-';

/** Un secreto ya abierto: cada clave con su valor como texto. */
export type Secret = {
  readonly reference: string;
  readonly entries: Readonly<Record<string, string>>;
};

/**
 * Lee la configuración de un almacén sin saber de dónde sale. Las claves son las
 * de Java, como `nova.secrets.vault.address`, y por defecto se leen del entorno
 * con el nombre de variable que les corresponde: `NOVA_SECRETS_VAULT_ADDRESS`.
 */
export type SecretSettings = (key: string) => string | undefined;

/** Un almacén de secretos: Vault, AWS Secrets Manager. */
export interface SecretSource {
  /**
   * El secreto que nombra la referencia, o `undefined` si el almacén no lo
   * tiene. Un almacén que contesta con un error rechaza la promesa.
   */
  find(reference: string): Promise<Secret | undefined>;
}

/** Crea un almacén con su configuración. Cada paquete de almacén exporta uno. */
export interface SecretSourceProvider {
  /** El nombre con que se pide: `vault`, `aws-secrets-manager`. */
  readonly name: string;
  create(settings: SecretSettings): SecretSource;
}

/** Un secreto que el servicio pide a un almacén. */
export type SecretImport = {
  readonly source: string;
  readonly reference: string;
  readonly optional: boolean;
};

/**
 * Falla al leer un secreto de un almacén. Nombra la referencia y **nunca el
 * contenido**, con la misma forma que en Java: `Secret <referencia> <razón>`.
 */
export class SecretSourceError extends Error {
  constructor(
    readonly reference: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Secret ${reference} ${reason}`, options);
    this.name = 'SecretSourceError';
  }
}

// Solo letras, números y guiones: el nombre de la fuente decide qué paquete se
// importa, y puede venir de una variable de entorno.
const SOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Lee un pedido escrito como `[optional:]<fuente>:<referencia>`. Solo el primer
 * `:` separa la fuente, así que un ARN de AWS se escribe tal cual.
 */
export function parseSecretImport(raw: string): SecretImport {
  let value = raw.trim();
  const optional = value.startsWith(OPTIONAL_PREFIX);
  if (optional) {
    value = value.slice(OPTIONAL_PREFIX.length);
  }
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `Secret import '${raw.trim()}' must be written as <source>:<reference>, such as vault:ms-course`,
    );
  }
  const source = value.slice(0, separator);
  if (!SOURCE_NAME.test(source)) {
    throw new Error(
      `Secret import '${raw.trim()}' names the source '${source}', which is not a lowercase name such as vault`,
    );
  }
  return { source, reference: value.slice(separator + 1), optional };
}

/** Lee una lista separada por comas, como la de {@link SECRET_IMPORT_VARIABLE}. */
export function parseSecretImports(raw: string | undefined): SecretImport[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map(parseSecretImport);
}

/** El pedido como se escribe, con `optional:` si corresponde. */
export function formatSecretImport(secretImport: SecretImport): string {
  return `${secretImport.optional ? OPTIONAL_PREFIX : ''}${secretImport.source}:${secretImport.reference}`;
}

/**
 * Abre el JSON de un secreto que devolvió un almacén, con las mismas reglas que
 * el entorno: un objeto, y solo sus valores escalares.
 */
export function secretFromJson(reference: string, raw: string): Secret {
  return {
    reference,
    entries: parseSecretJson(
      raw,
      (reason) => new SecretSourceError(reference, reason),
    ),
  };
}

/** El nombre de variable de una clave: `nova.secrets.vault.app-role.role-id` → `NOVA_SECRETS_VAULT_APP_ROLE_ROLE_ID`. */
export function settingVariable(key: string): string {
  return key.replace(/[.-]/g, '_').toUpperCase();
}

/**
 * La configuración de los almacenes: primero lo que el servicio pasa en código,
 * después el entorno con el nombre de variable de cada clave. Un valor en blanco
 * cuenta como ausente.
 */
export function secretSettings(
  env: NodeJS.ProcessEnv = process.env,
  values: Readonly<Record<string, string>> = {},
): SecretSettings {
  return (key) => {
    const value = values[key] ?? env[settingVariable(key)];
    return value === undefined || value.trim() === '' ? undefined : value;
  };
}

/**
 * Una duración de la configuración, en milisegundos: `500ms`, `5s`, `1m` o la
 * forma ISO, como `PT5S`. Las mismas que acepta Java.
 */
export function durationSetting(
  settings: SecretSettings,
  key: string,
  fallbackMs: number,
): number {
  const raw = settings(key)?.trim();
  if (raw === undefined) {
    return fallbackMs;
  }
  const simple = /^(\d+)\s*(ms|s|m)$/.exec(raw);
  if (simple) {
    const amount = Number(simple[1]);
    return simple[2] === 'ms'
      ? amount
      : simple[2] === 's'
        ? amount * 1000
        : amount * 60_000;
  }
  const iso = /^PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(raw);
  if (iso && (iso[1] !== undefined || iso[2] !== undefined)) {
    return Number(iso[1] ?? 0) * 60_000 + Number(iso[2] ?? 0) * 1000;
  }
  throw new SecretSourceError(
    `setting ${key}`,
    'is not a duration, such as 5s or PT5S',
  );
}

export type ImportSecretsOptions = {
  /** Los pedidos del servicio; se suman a los de {@link SECRET_IMPORT_VARIABLE}. */
  readonly imports?: readonly string[];

  /**
   * Almacenes pasados a mano, por nombre. Sin ellos, cada fuente se busca en el
   * paquete de su nombre, así que cambiar de almacén es cambiar una dependencia.
   */
  readonly sources?: readonly SecretSourceProvider[];

  /** Configuración de los almacenes en código; gana sobre el entorno. */
  readonly settings?: Readonly<Record<string, string>>;

  /**
   * Si una clave del secreto pisa una variable que ya existía. Por defecto
   * `true`, como en el desdoblado del entorno y en Java.
   */
  readonly override?: boolean;

  /** De dónde se lee y dónde se escribe. Por defecto `process.env`. */
  readonly env?: NodeJS.ProcessEnv;

  /**
   * La carpeta del servicio, desde donde se resuelve el paquete de cada
   * almacén. Por defecto el directorio de trabajo del proceso.
   */
  readonly root?: string;
};

type LoadedSecrets = { readonly import: SecretImport; readonly secret: Secret };

/**
 * Lee los secretos que el servicio pide a sus almacenes y escribe sus claves en
 * el entorno, antes de que exista la aplicación (ADR-042, regla 1).
 *
 * Aplica las reglas de ADR-042 igual que Java: una fuente que no está instalada
 * corta el arranque y dice qué paquete falta, un secreto obligatorio que no
 * existe también, y un `optional:` que no existe se salta. Entre dos pedidos con
 * la misma clave gana el último.
 *
 * @param protectedKeys las variables que ya existían antes de desdoblar nada:
 * con `override` en `false`, son las únicas que un secreto no pisa.
 * @returns los pedidos que trajeron un secreto, como se escribieron.
 */
export async function importSecrets(
  options: ImportSecretsOptions = {},
  protectedKeys?: ReadonlySet<string>,
): Promise<string[]> {
  const env = options.env ?? process.env;
  const override = options.override ?? true;
  const before = protectedKeys ?? new Set(Object.keys(env));
  const imports = [
    ...(options.imports ?? []).map(parseSecretImport),
    ...parseSecretImports(env[SECRET_IMPORT_VARIABLE]),
  ];
  if (imports.length === 0) {
    return [];
  }

  const settings = secretSettings(env, options.settings);
  const sources = new Map<string, SecretSource>();
  const loaded: LoadedSecrets[] = [];
  for (const secretImport of imports) {
    let source = sources.get(secretImport.source);
    if (source === undefined) {
      const provider = providerFor(
        secretImport,
        options.sources,
        options.root ?? process.cwd(),
      );
      source = provider.create(settings);
      sources.set(secretImport.source, source);
    }
    const secret = await source.find(secretImport.reference);
    if (secret !== undefined) {
      loaded.push({ import: secretImport, secret });
    } else if (!secretImport.optional) {
      const written = formatSecretImport(secretImport);
      throw new SecretSourceError(
        written,
        `does not exist; write optional:${written} if it may`,
      );
    }
  }

  // Se escribe al final y no a medida que llegan, para que un pedido que falla
  // no deje el entorno a medio cargar.
  for (const { secret } of loaded) {
    for (const [key, value] of Object.entries(secret.entries)) {
      if (!override && before.has(key)) {
        continue;
      }
      env[key] = value;
    }
  }
  return loaded.map((item) => formatSecretImport(item.import));
}

function providerFor(
  secretImport: SecretImport,
  given: readonly SecretSourceProvider[] | undefined,
  root: string,
): SecretSourceProvider {
  const explicit = given?.find(
    (provider) => provider.name === secretImport.source,
  );
  if (explicit !== undefined) {
    return explicit;
  }

  // Se resuelve desde la carpeta del servicio y no desde este paquete: el
  // almacén es una dependencia del servicio, y con pnpm un paquete solo ve sus
  // propias dependencias, así que desde acá no lo encontraría.
  const packageName = `${SECRET_SOURCE_PACKAGE_PREFIX}${secretImport.source}`;
  const fromService = createRequire(join(root, 'package.json'));
  let loadedModule: { secretSourceProvider?: SecretSourceProvider };
  try {
    loadedModule = fromService(packageName) as {
      secretSourceProvider?: SecretSourceProvider;
    };
  } catch (error) {
    if (isMissing(error, packageName)) {
      throw new SecretSourceError(
        formatSecretImport(secretImport),
        `needs the package ${packageName}; each store is a dependency`,
      );
    }
    throw error;
  }
  const provider = loadedModule.secretSourceProvider;
  if (provider === undefined || provider.name !== secretImport.source) {
    throw new SecretSourceError(
      formatSecretImport(secretImport),
      `cannot be read: ${packageName} does not export a secretSourceProvider named ${secretImport.source}`,
    );
  }
  return provider;
}

function isMissing(error: unknown, packageName: string): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  return (
    (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
    message.includes(packageName)
  );
}

/**
 * Los secretos de un servicio: lo que desdobla del entorno y lo que pide a sus
 * almacenes. Es lo que reciben `bootstrap()` y el perfil de una organización.
 */
export type SecretsOptions = UnfoldSecretsOptions &
  Pick<ImportSecretsOptions, 'imports' | 'sources' | 'settings' | 'root'>;
