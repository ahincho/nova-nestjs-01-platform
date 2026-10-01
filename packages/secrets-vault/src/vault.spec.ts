import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  importSecrets,
  secretSettings,
  type SecretSource,
} from '@ahincho/nova-nestjs';
import {
  GenericContainer,
  getContainerRuntimeClient,
  Wait,
} from 'testcontainers';
import { secretSourceProvider } from './vault';

type Handler = (
  request: IncomingMessage,
  body: string,
) => { status: number; body?: unknown } | 'hang';

/** Un Vault de mentira en un puerto local, para probar el protocolo sin Docker. */
async function fakeVault(
  handler: Handler,
): Promise<{ address: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      calls.push(`${request.method} ${request.url}`);
      const answer = handler(request, body);
      if (answer === 'hang') {
        return;
      }
      response.writeHead(answer.status, { 'Content-Type': 'application/json' });
      response.end(
        typeof answer.body === 'string'
          ? answer.body
          : JSON.stringify(answer.body ?? {}),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** El error con que se rechaza la promesa; falla si la promesa se cumple. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected the promise to be rejected');
    },
    (caught: unknown) => caught as Error,
  );
}

function source(values: Record<string, string>): SecretSource {
  return secretSourceProvider.create(secretSettings({}, values));
}

const KV = (data: Record<string, unknown> | null) => ({
  status: 200,
  body: { data: { data, metadata: { version: 1 } } },
});

describe('the Vault secret source', () => {
  let vault: Awaited<ReturnType<typeof fakeVault>> | undefined;

  afterEach(async () => {
    await vault?.close();
    vault = undefined;
  });

  it('reads the data of a KV version 2 secret with the token', async () => {
    let token: string | undefined;
    vault = await fakeVault((request) => {
      token = request.headers['x-vault-token'] as string;
      return KV({ DB_USERNAME: 'course', DB_PASSWORD: 's3cr3t', PORT: 5432 });
    });

    const secret = await source({
      'nova.secrets.vault.address': `${vault.address}/`,
      'nova.secrets.vault.token': 'root',
    }).find('ms-course');

    expect(secret?.entries).toEqual({
      DB_USERNAME: 'course',
      DB_PASSWORD: 's3cr3t',
      PORT: '5432',
    });
    expect(token).toBe('root');
    expect(vault.calls).toEqual(['GET /v1/secret/data/ms-course']);
  });

  it('honours VAULT_ADDR, VAULT_TOKEN and another mount', async () => {
    vault = await fakeVault(() => KV({ A: 'b' }));

    const secret = await secretSourceProvider
      .create(
        secretSettings({
          VAULT_ADDR: vault.address,
          VAULT_TOKEN: 'root',
          NOVA_SECRETS_VAULT_MOUNT: 'kv',
        }),
      )
      .find('team/ms-course');

    expect(secret?.entries).toEqual({ A: 'b' });
    expect(vault.calls).toEqual(['GET /v1/kv/data/team/ms-course']);
  });

  it('answers a secret Vault does not have, or a deleted one, as missing', async () => {
    vault = await fakeVault((request) =>
      request.url?.endsWith('/gone') ? KV(null) : { status: 404 },
    );
    const vaultSource = source({
      'nova.secrets.vault.address': vault.address,
      'nova.secrets.vault.token': 'root',
    });

    await expect(vaultSource.find('missing')).resolves.toBeUndefined();
    await expect(vaultSource.find('gone')).resolves.toBeUndefined();
  });

  it('says when Vault refuses the token or fails', async () => {
    vault = await fakeVault((request) =>
      request.url?.endsWith('/forbidden') ? { status: 403 } : { status: 503 },
    );
    const vaultSource = source({
      'nova.secrets.vault.address': vault.address,
      'nova.secrets.vault.token': 'root',
    });

    await expect(vaultSource.find('forbidden')).rejects.toThrow(
      'Secret forbidden was refused by Vault (403): the token or the AppRole cannot read it',
    );
    await expect(vaultSource.find('sealed')).rejects.toThrow(
      'Secret sealed could not be read from Vault (status 503)',
    );
  });

  it('logs in with AppRole once, even for two secrets asked at the same time', async () => {
    vault = await fakeVault((request, body) => {
      if (request.url === '/v1/auth/approle/login') {
        const credentials = JSON.parse(body) as Record<string, string>;
        return credentials.role_id === 'role' && credentials.secret_id === 'id'
          ? { status: 200, body: { auth: { client_token: 'issued' } } }
          : { status: 400 };
      }
      return request.headers['x-vault-token'] === 'issued'
        ? KV({ A: 'b' })
        : { status: 403 };
    });
    const vaultSource = source({
      'nova.secrets.vault.address': vault.address,
      'nova.secrets.vault.app-role.role-id': 'role',
      'nova.secrets.vault.app-role.secret-id': 'id',
    });

    await Promise.all([vaultSource.find('one'), vaultSource.find('two')]);

    expect(vault.calls.filter((call) => call.includes('/login'))).toHaveLength(
      1,
    );
  });

  it('says when the AppRole login is refused, without quoting the response', async () => {
    vault = await fakeVault(() => ({
      status: 400,
      body: { errors: ['invalid role ID or secret ID'] },
    }));

    await expect(
      source({
        'nova.secrets.vault.address': vault.address,
        'nova.secrets.vault.app-role.role-id': 'role',
        'nova.secrets.vault.app-role.secret-id': 'wrong',
      }).find('ms-course'),
    ).rejects.toThrow(
      'Secret ms-course could not be read: the AppRole login was refused by Vault (status 400)',
    );
  });

  it('never quotes a response it cannot parse', async () => {
    vault = await fakeVault(() => ({
      status: 200,
      body: '{"data": {"data": {"DB_PASSWORD": s3cr3t',
    }));

    const error = await rejection(
      source({
        'nova.secrets.vault.address': vault.address,
        'nova.secrets.vault.token': 'root',
      }).find('ms-course'),
    );

    expect(error.message).toBe(
      'Secret ms-course could not be parsed from the Vault response',
    );
    expect(error.message).not.toContain('s3cr3t');
  });

  it('gives up after its timeout', async () => {
    vault = await fakeVault(() => 'hang');

    await expect(
      source({
        'nova.secrets.vault.address': vault.address,
        'nova.secrets.vault.token': 'root',
        'nova.secrets.vault.timeout': '200ms',
      }).find('ms-course'),
    ).rejects.toThrow(
      'Secret ms-course could not be read: Vault did not answer within 200 ms',
    );
  });

  it('says when Vault is not reachable', async () => {
    await expect(
      source({
        'nova.secrets.vault.address': 'http://127.0.0.1:1',
        'nova.secrets.vault.token': 'root',
      }).find('ms-course'),
    ).rejects.toThrow(
      'Secret ms-course could not be read: Vault is not reachable at http://127.0.0.1:1',
    );
  });

  it('rejects a reference that is not a Vault path', async () => {
    await expect(
      source({
        'nova.secrets.vault.address': 'http://127.0.0.1:1',
        'nova.secrets.vault.token': 'root',
      }).find('../sys/seal'),
    ).rejects.toThrow('Secret ../sys/seal is not a valid Vault path');
  });

  it.each([
    [{}, 'needs an address: set nova.secrets.vault.address or VAULT_ADDR'],
    [
      { 'nova.secrets.vault.address': 'ftp://vault' },
      'needs an http or https address',
    ],
    [
      { 'nova.secrets.vault.address': 'http://vault' },
      'needs a token or an AppRole',
    ],
    [
      {
        'nova.secrets.vault.address': 'http://vault',
        'nova.secrets.vault.app-role.role-id': 'role',
      },
      'has an AppRole role-id without its secret-id',
    ],
    [
      {
        'nova.secrets.vault.address': 'http://vault',
        'nova.secrets.vault.token': 'root',
        'nova.secrets.vault.mount': '../sys',
      },
      'has a mount that is not a Vault path',
    ],
  ])('names what is wrong with its settings: %j', (values, message) => {
    expect(() => source(values)).toThrow(`Secret source vault ${message}`);
  });
});

// De punta a punta, contra un Vault real. Se salta si la máquina no tiene Docker.
describe('a real Vault', () => {
  const ROOT_TOKEN = 'nova-test-root';
  let docker = false;
  let container: Awaited<ReturnType<GenericContainer['start']>> | undefined;
  let address: string;

  beforeAll(async () => {
    docker = await getContainerRuntimeClient().then(
      () => true,
      () => false,
    );
    if (!docker) {
      return;
    }
    container = await new GenericContainer('hashicorp/vault:2.1.1')
      .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: ROOT_TOKEN })
      .withExposedPorts(8200)
      .withWaitStrategy(Wait.forHttp('/v1/sys/health', 8200))
      .start();
    address = `http://${container.getHost()}:${container.getMappedPort(8200)}`;
    const write = await container.exec(
      [
        'vault',
        'kv',
        'put',
        `-address=http://127.0.0.1:8200`,
        'secret/plaza-bff',
        'DB_USERNAME=bff',
        'DB_PASSWORD=from-vault',
      ],
      { env: { VAULT_TOKEN: ROOT_TOKEN } },
    );
    expect(write.exitCode).toBe(0);
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('loads the secret into the environment as a service does', async (ctx) => {
    if (!docker) {
      ctx.skip();
    }
    const env: NodeJS.ProcessEnv = {
      VAULT_ADDR: address,
      VAULT_TOKEN: ROOT_TOKEN,
      NOVA_SECRETS_IMPORT: 'vault:plaza-bff, optional:vault:not-there',
    };

    const imported = await importSecrets({
      env,
      sources: [secretSourceProvider],
    });

    expect(imported).toEqual(['vault:plaza-bff']);
    expect(env.DB_USERNAME).toBe('bff');
    expect(env.DB_PASSWORD).toBe('from-vault');
  });
});
