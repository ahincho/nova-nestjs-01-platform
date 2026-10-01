import type { JwtClaims } from './jwt';

export const AUTH_OPTIONS = Symbol('NOVA_AUTH_OPTIONS');

/**
 * El claim del que sale el identificador del usuario. `preferred_username` es
 * un claim estándar de OpenID Connect, no de un proveedor.
 */
export const DEFAULT_ID_CLAIM = 'preferred_username';

/**
 * Dónde están los roles. `roles` es el claim que define RFC 9068 para un token
 * de acceso.
 *
 * Cada proveedor pone los suyos donde quiere -Keycloak, por ejemplo, en
 * `realm_access.roles`-, y eso lo declara el perfil de la organización
 * (ADR-036). Un default de un proveedor concreto dejaba en 401 a todo token
 * que no fuera de ese proveedor.
 */
export const DEFAULT_ROLES_CLAIM = 'roles';

/**
 * Roles que describen lo que el token puede hacer y no quién lo trae. Por
 * defecto ninguno: cuáles son depende del proveedor. Keycloak, por ejemplo,
 * agrega `offline_access` y `uma_authorization`.
 */
export const DEFAULT_IGNORED_ROLES: readonly string[] = [];

/**
 * Prefijos de roles con el mismo tratamiento. Por defecto ninguno; Keycloak
 * agrega `default-roles-<realm>`.
 */
export const DEFAULT_IGNORED_ROLE_PREFIXES: readonly string[] = [];

/** La cabecera con la que el id del usuario viaja hacia los upstreams. */
export const DEFAULT_USER_ID_HEADER = 'x-user-id';

/**
 * El identificador tal como vino, sin los espacios de los bordes.
 *
 * Es lo único que se puede hacer sin conocer al emisor: cualquier otra
 * transformación inventa una convención.
 */
export function trimUserId(raw: string): string {
  return raw.trim();
}

/**
 * Normaliza el identificador: sin espacios, sin la arroba inicial y en
 * mayúsculas, para que el mismo usuario sea la misma cadena en todos los logs.
 *
 * @deprecated Es la convención de una organización y ya no es el default: se
 * declara en su perfil como `auth: { normalizeId: normalizeUserId }`. Sigue
 * existiendo para no romper a quien la usaba.
 */
export function normalizeUserId(raw: string): string {
  return raw.trim().replace(/^@/, '').toUpperCase();
}

export type NovaAuthModuleOptions = {
  /**
   * De qué claim sale el identificador. Por defecto `preferred_username`.
   *
   * A propósito no es `sub`: `sub` es el identificador interno del emisor, que
   * no le sirve a nadie aguas abajo y cambia si el usuario se recrea.
   */
  readonly idClaim?: string;

  /** Cómo se normaliza ese valor. Por defecto {@link trimUserId}. */
  readonly normalizeId?: (raw: string) => string;

  /**
   * Dónde están los roles, como ruta con puntos. Por defecto `roles`, el claim
   * de RFC 9068; con Keycloak es `realm_access.roles`. Tiene que resolver a un
   * arreglo.
   */
  readonly rolesClaim?: string;

  /**
   * Si el token trae varios roles utilizables, cuál gana. Se comparan sin
   * distinguir mayúsculas y se devuelve el valor de esta lista, así que el rol
   * que ve la aplicación no depende de cómo lo escribió el emisor.
   */
  readonly preferredRoles?: readonly string[];

  /** Roles que nunca describen a un usuario. */
  readonly ignoredRoles?: readonly string[];

  /** Prefijos de roles con el mismo tratamiento. */
  readonly ignoredRolePrefixes?: readonly string[];

  /**
   * Con qué cabecera viaja el identificador hacia los upstreams. Por defecto
   * `x-user-id`. Se agrega al contexto de la petición, así que ningún punto de
   * llamada tiene que pasarla.
   */
  readonly userIdHeader?: string;

  /**
   * Con qué cabecera viaja el rol hacia los upstreams. Sin default: el rol no
   * sale del servicio si nadie lo pide, porque qué capa lo necesita es decisión
   * de cada organización.
   */
  readonly roleHeader?: string;

  /**
   * Comprueba la firma y devuelve los claims.
   *
   * **Sin esto no se verifica ninguna firma**: los claims se leen del token tal
   * como vino, que es lo correcto sólo si un gateway delante ya lo validó y
   * rechaza el inválido. Si el servicio se expone directamente, acá va una
   * verificación real contra el JWKS del emisor.
   */
  readonly verify?: (token: string) => JwtClaims | Promise<JwtClaims>;
};

export type ResolvedAuthOptions = {
  readonly idClaim: string;
  readonly normalizeId: (raw: string) => string;
  readonly rolesClaim: string;
  readonly preferredRoles: readonly string[];
  readonly ignoredRoles: readonly string[];
  readonly ignoredRolePrefixes: readonly string[];
  readonly userIdHeader: string;
  readonly roleHeader: string | undefined;
  readonly verify:
    ((token: string) => JwtClaims | Promise<JwtClaims>) | undefined;
};

export function resolveAuthOptions(
  options: NovaAuthModuleOptions = {},
): ResolvedAuthOptions {
  return {
    idClaim: options.idClaim ?? DEFAULT_ID_CLAIM,
    normalizeId: options.normalizeId ?? trimUserId,
    rolesClaim: options.rolesClaim ?? DEFAULT_ROLES_CLAIM,
    preferredRoles: options.preferredRoles ?? [],
    ignoredRoles: options.ignoredRoles ?? DEFAULT_IGNORED_ROLES,
    ignoredRolePrefixes:
      options.ignoredRolePrefixes ?? DEFAULT_IGNORED_ROLE_PREFIXES,
    userIdHeader: options.userIdHeader ?? DEFAULT_USER_ID_HEADER,
    roleHeader: options.roleHeader,
    verify: options.verify,
  };
}
