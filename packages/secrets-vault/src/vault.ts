import {
  SecretSourceError,
  durationSetting,
  secretFromJson,
  type Secret,
  type SecretSettings,
  type SecretSource,
  type SecretSourceProvider,
} from '@ahincho/nova-nestjs';

/** El nombre con que se pide: `vault:<ruta>`. */
export const VAULT_SOURCE = 'vault';

const PREFIX = 'nova.secrets.vault.';
const DEFAULT_MOUNT = 'secret';
const DEFAULT_APP_ROLE_MOUNT = 'approle';
const DEFAULT_TIMEOUT_MS = 5000;

// Una ruta de Vault: segmentos con letras, números, punto, guion y guion bajo.
// Una referencia nunca puede subir de nivel ni salir del motor.
const PATH =
  /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

type Authentication =
  | { readonly kind: 'token'; readonly token: string }
  | {
      readonly kind: 'app-role';
      readonly roleId: string;
      readonly secretId: string;
      readonly mount: string;
    };

type VaultSettings = {
  readonly address: string;
  readonly mount: string;
  readonly timeoutMs: number;
  readonly authentication: Authentication;
};

function invalid(reason: string): SecretSourceError {
  return new SecretSourceError('source vault', reason);
}

/**
 * La configuración, con las mismas claves que en Java. Donde Vault tiene su
 * convención, Nova la respeta: `VAULT_ADDR` y `VAULT_TOKEN`.
 */
function vaultSettings(settings: SecretSettings): VaultSettings {
  const raw = settings(`${PREFIX}address`) ?? settings('vault.addr');
  if (raw === undefined) {
    throw invalid(
      'needs an address: set nova.secrets.vault.address or VAULT_ADDR',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('has an address that is not a URI');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('needs an http or https address');
  }
  const mount = settings(`${PREFIX}mount`) ?? DEFAULT_MOUNT;
  if (!PATH.test(mount)) {
    throw invalid('has a mount that is not a Vault path');
  }
  return {
    address: raw.replace(/\/+$/, ''),
    mount,
    timeoutMs: durationSetting(
      settings,
      `${PREFIX}timeout`,
      DEFAULT_TIMEOUT_MS,
    ),
    authentication: authentication(settings),
  };
}

function authentication(settings: SecretSettings): Authentication {
  const roleId = settings(`${PREFIX}app-role.role-id`);
  if (roleId !== undefined) {
    const secretId = settings(`${PREFIX}app-role.secret-id`);
    if (secretId === undefined) {
      throw invalid('has an AppRole role-id without its secret-id');
    }
    const mount = settings(`${PREFIX}app-role.mount`) ?? DEFAULT_APP_ROLE_MOUNT;
    if (!PATH.test(mount)) {
      throw invalid('has an AppRole mount that is not a Vault path');
    }
    return { kind: 'app-role', roleId, secretId, mount };
  }
  const token = settings(`${PREFIX}token`) ?? settings('vault.token');
  if (token === undefined) {
    throw invalid(
      'needs a token or an AppRole: set nova.secrets.vault.token, VAULT_TOKEN ' +
        'or nova.secrets.vault.app-role.role-id and secret-id',
    );
  }
  return { kind: 'token', token };
}

/**
 * Vault, motor KV versión 2, por su API HTTP y con el `fetch` de Node, sin un
 * cliente de terceros. Es el mismo protocolo y los mismos errores que el
 * adaptador de Java (ADR-042).
 */
class VaultSecretSource implements SecretSource {
  // La promesa y no el token, para que dos pedidos a la vez inicien sesión una sola vez.
  private token: Promise<string> | undefined;

  constructor(private readonly vault: VaultSettings) {
    if (vault.authentication.kind === 'token') {
      this.token = Promise.resolve(vault.authentication.token);
    }
  }

  async find(reference: string): Promise<Secret | undefined> {
    if (!PATH.test(reference)) {
      throw new SecretSourceError(reference, 'is not a valid Vault path');
    }
    const token = await this.login(reference);
    const response = await this.send(
      reference,
      `${this.vault.mount}/data/${reference}`,
      { method: 'GET', headers: { 'X-Vault-Token': token } },
    );
    if (response.status === 404) {
      return undefined;
    }
    if (response.status === 403) {
      throw new SecretSourceError(
        reference,
        'was refused by Vault (403): the token or the AppRole cannot read it',
      );
    }
    if (response.status !== 200) {
      throw new SecretSourceError(
        reference,
        `could not be read from Vault (status ${response.status})`,
      );
    }
    return data(reference, await this.text(reference, response));
  }

  private login(reference: string): Promise<string> {
    if (this.token === undefined) {
      const appRole = this.vault.authentication as Extract<
        Authentication,
        { kind: 'app-role' }
      >;
      this.token = this.appRoleLogin(reference, appRole);
      // Un inicio de sesión fallido no queda guardado: el próximo pedido lo reintenta.
      this.token.catch(() => {
        this.token = undefined;
      });
    }
    return this.token;
  }

  private async appRoleLogin(
    reference: string,
    appRole: Extract<Authentication, { kind: 'app-role' }>,
  ): Promise<string> {
    const response = await this.send(reference, `auth/${appRole.mount}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role_id: appRole.roleId,
        secret_id: appRole.secretId,
      }),
    });
    if (response.status !== 200) {
      throw new SecretSourceError(
        reference,
        `could not be read: the AppRole login was refused by Vault (status ${response.status})`,
      );
    }
    const body = await this.text(reference, response);
    let token: unknown;
    try {
      token = (JSON.parse(body) as { auth?: { client_token?: unknown } }).auth
        ?.client_token;
    } catch {
      // La respuesta trae un token: no se cita ni se encadena.
    }
    if (typeof token !== 'string' || token === '') {
      throw new SecretSourceError(
        reference,
        'could not be read: the AppRole login did not return a token',
      );
    }
    return token;
  }

  private async send(
    reference: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(`${this.vault.address}/v1/${path}`, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.vault.timeoutMs),
      });
    } catch (error) {
      throw this.failure(reference, error);
    }
  }

  private async text(reference: string, response: Response): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw this.failure(reference, error);
    }
  }

  private failure(reference: string, error: unknown): SecretSourceError {
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      return new SecretSourceError(
        reference,
        `could not be read: Vault did not answer within ${this.vault.timeoutMs} ms`,
      );
    }
    return new SecretSourceError(
      reference,
      `could not be read: Vault is not reachable at ${this.vault.address}`,
      { cause: error },
    );
  }
}

/** Saca `data.data` de la respuesta del motor KV versión 2. */
function data(reference: string, body: string): Secret | undefined {
  let inner: unknown;
  try {
    inner = (JSON.parse(body) as { data?: { data?: unknown } }).data?.data;
  } catch {
    // La causa se descarta a propósito: el mensaje del parser cita la respuesta, que trae el secreto.
    throw new SecretSourceError(
      reference,
      'could not be parsed from the Vault response',
    );
  }
  if (inner === undefined || inner === null) {
    return undefined;
  }
  if (typeof inner !== 'object' || Array.isArray(inner)) {
    throw new SecretSourceError(
      reference,
      'could not be parsed from the Vault response',
    );
  }
  return secretFromJson(reference, JSON.stringify(inner));
}

/**
 * La fuente `vault`. `core` la encuentra sola cuando un servicio pide
 * `vault:<ruta>`, porque este paquete la exporta con este nombre.
 */
export const secretSourceProvider: SecretSourceProvider = {
  name: VAULT_SOURCE,
  create: (settings) => new VaultSecretSource(vaultSettings(settings)),
};
