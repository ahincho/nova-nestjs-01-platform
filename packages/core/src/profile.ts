import type { ApiStandardModuleOptions, NovaErrorsOptions } from './api';
import type { NovaAuthModuleOptions } from './auth';
import type { SecretsOptions } from './config';
import type { NovaHealthModuleOptions } from './health';
import type { NovaHttpModuleOptions } from './http';
import type { NovaObservabilityModuleOptions } from './observability';

/**
 * Token con el nombre del perfil que recibió `NovaModule.forRoot()`, o `null`
 * si no recibió ninguno. `bootstrap()` lo compara con el suyo.
 */
export const NOVA_PROFILE = Symbol('NOVA_PROFILE');

/**
 * Lo que un perfil ajusta del arranque. Son las convenciones de una
 * organización que se deciden antes de que exista la aplicación o fuera de los
 * módulos: de qué variable sale el puerto, cómo llegan sus secretos, bajo qué
 * prefijo expone sus rutas.
 */
export type NovaProfileBootstrapOptions = {
  /** De qué variables se lee el puerto, en orden. */
  readonly portVariables?: readonly string[];

  /**
   * Cómo llegan los secretos de la organización: lo que se desdobla del
   * entorno que inyecta su plataforma y, si los usa, los almacenes que pide.
   * Declararlo enciende el desdoblado para todo servicio del perfil; un
   * servicio lo apaga con `secrets: false`.
   */
  readonly secrets?: SecretsOptions;

  /** Prefijo de todas las rutas salvo las sondas. */
  readonly globalPrefix?: string;
};

/**
 * Las convenciones de una organización, declaradas una sola vez (ADR-036).
 *
 * Un perfil ajusta las implementaciones por defecto de Nova y nada más: ve las
 * mismas opciones que ve un servicio, así que no puede tocar una regla del
 * núcleo. El orden es fijo -defaults de Nova, después el perfil, después el
 * servicio-, y el servicio sigue pudiendo cambiar cualquier cosa.
 *
 * Nova no publica ningún perfil. Cada organización publica el suyo, en su
 * propio paquete.
 */
export type NovaProfile = {
  /** Cómo se llama. Es lo que `bootstrap()` compara con el del módulo. */
  readonly name: string;

  readonly apiStandard?: ApiStandardModuleOptions;

  /**
   * Los puertos de errores de la organización (ADR-031): su catálogo de códigos
   * y mensajes, su tabla de status, su serializador. Es donde vive lo que es de
   * una organización y no de Nova, como el catálogo de UTP.
   *
   * Ven el mismo fallo saneado que ve un servicio, así que no pueden romper la
   * regla de que un 5xx nunca revela al proveedor.
   */
  readonly errors?: NovaErrorsOptions;

  readonly observability?: NovaObservabilityModuleOptions;
  readonly http?: NovaHttpModuleOptions;

  /**
   * Las sondas. Si declara `legacyPath`, `bootstrap()` la deja fuera del
   * prefijo global sin que el servicio tenga que repetirla.
   */
  readonly health?: NovaHealthModuleOptions;

  /**
   * Cómo se lee un token en esta organización: de qué claim sale el usuario,
   * dónde están los roles, cómo se normaliza el id.
   *
   * **No enciende la autenticación.** La enciende el servicio declarando
   * `auth`, porque el guard es global: un perfil que la activara dejaría en 401
   * a todo servicio interno que no manda token.
   */
  readonly auth?: NovaAuthModuleOptions;

  readonly bootstrap?: NovaProfileBootstrapOptions;
};

/**
 * Declara un perfil. Existe para que el tipo lo verifique el compilador en el
 * paquete del perfil y no recién en el servicio que lo usa.
 *
 * @example
 * export const acme = defineProfile({
 *   name: 'acme',
 *   bootstrap: { portVariables: ['APP_PORT', 'PORT'], globalPrefix: 'api/v1' },
 *   health: { legacyPath: 'api/v1/health' },
 * });
 */
export function defineProfile(profile: NovaProfile): NovaProfile {
  if (profile.name.trim() === '') {
    throw new Error('A Nova profile needs a name');
  }
  return profile;
}

/**
 * Combina las opciones de un módulo: las del servicio pisan las del perfil,
 * opción por opción de primer nivel.
 *
 * No es un spread: `{ ...perfil, ...servicio }` dejaría que un `undefined`
 * explícito del servicio borrara el valor del perfil.
 */
export function mergeOptions<T extends object>(
  base: T | undefined,
  override: T | undefined,
): T | undefined {
  if (base === undefined) {
    return override;
  }
  if (override === undefined) {
    return base;
  }

  const merged: Record<string, unknown> = { ...(base as object) };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as T;
}
