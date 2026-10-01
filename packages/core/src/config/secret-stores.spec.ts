import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SECRET_IMPORT_VARIABLE,
  SecretSourceError,
  durationSetting,
  formatSecretImport,
  importSecrets,
  parseSecretImport,
  parseSecretImports,
  secretFromJson,
  secretSettings,
  settingVariable,
  type Secret,
  type SecretSettings,
  type SecretSourceProvider,
} from './secret-stores';

/** Un almacén en memoria que cuenta cuántas veces se crea. */
function memoryStore(
  secrets: Record<string, Record<string, string>>,
): SecretSourceProvider & { created: number; settings?: SecretSettings } {
  const provider = {
    name: 'memory',
    created: 0,
    settings: undefined as SecretSettings | undefined,
    create(settings: SecretSettings) {
      provider.created += 1;
      provider.settings = settings;
      return {
        find: (reference: string): Promise<Secret | undefined> =>
          Promise.resolve(
            secrets[reference] === undefined
              ? undefined
              : { reference, entries: secrets[reference] },
          ),
      };
    },
  };
  return provider;
}

const STORE = {
  'ms-course': { DB_USERNAME: 'course', DB_PASSWORD: 's3cr3t' },
  'ms-course-v2': { DB_PASSWORD: 'rotated' },
};

describe('parseSecretImport', () => {
  it('splits the source from the reference at the first colon only', () => {
    expect(
      parseSecretImport('aws-secrets-manager:arn:aws:secretsmanager:x:1:db'),
    ).toEqual({
      source: 'aws-secrets-manager',
      reference: 'arn:aws:secretsmanager:x:1:db',
      optional: false,
    });
  });

  it('reads the optional prefix and writes it back', () => {
    const secretImport = parseSecretImport(' optional:vault:ms-course ');

    expect(secretImport).toEqual({
      source: 'vault',
      reference: 'ms-course',
      optional: true,
    });
    expect(formatSecretImport(secretImport)).toBe('optional:vault:ms-course');
  });

  it.each(['vault', 'vault:', ':ms-course', 'optional:vault', ''])(
    'says how to write %j',
    (raw) => {
      expect(() => parseSecretImport(raw)).toThrow('<source>:<reference>');
    },
  );

  // El nombre decide qué paquete se importa, y puede venir del entorno.
  it.each(['../evil:x', 'Vault:x', '@scope/pkg:x'])(
    'rejects %j as a source name',
    (raw) => {
      expect(() => parseSecretImport(raw)).toThrow('lowercase name');
    },
  );

  it('parses a comma separated list and drops blanks', () => {
    expect(parseSecretImports('vault:a, ,optional:vault:b,')).toHaveLength(2);
    expect(parseSecretImports(undefined)).toEqual([]);
  });
});

describe('secretSettings', () => {
  it('reads each key from its environment variable, as Spring and Quarkus do', () => {
    const settings = secretSettings({
      NOVA_SECRETS_VAULT_APP_ROLE_ROLE_ID: 'role',
      VAULT_ADDR: 'http://vault:8200',
      BLANK: ' ',
    });

    expect(settingVariable('nova.secrets.vault.app-role.role-id')).toBe(
      'NOVA_SECRETS_VAULT_APP_ROLE_ROLE_ID',
    );
    expect(settings('nova.secrets.vault.app-role.role-id')).toBe('role');
    expect(settings('vault.addr')).toBe('http://vault:8200');
    expect(settings('blank')).toBeUndefined();
  });

  it('lets the service pass a value in code that wins over the environment', () => {
    const settings = secretSettings(
      { NOVA_SECRETS_VAULT_MOUNT: 'kv' },
      { 'nova.secrets.vault.mount': 'secret' },
    );

    expect(settings('nova.secrets.vault.mount')).toBe('secret');
  });
});

describe('durationSetting', () => {
  it.each([
    ['500ms', 500],
    ['2s', 2000],
    ['1m', 60_000],
    ['PT3S', 3000],
    ['PT1M30S', 90_000],
  ])('reads %s', (raw, expected) => {
    expect(durationSetting(() => raw, 'timeout', 5000)).toBe(expected);
  });

  it('falls back when the setting is missing and names a bad one', () => {
    expect(durationSetting(() => undefined, 'timeout', 5000)).toBe(5000);
    expect(() => durationSetting(() => 'soon', 'timeout', 5000)).toThrow(
      'Secret setting timeout is not a duration, such as 5s or PT5S',
    );
  });
});

describe('secretFromJson', () => {
  it('keeps the scalar values and never quotes a broken secret', () => {
    expect(
      secretFromJson(
        'ms-course',
        '{"A":"x","PORT":5432,"NESTED":{"k":1},"N":null}',
      ).entries,
    ).toEqual({ A: 'x', PORT: '5432' });

    const error = (() => {
      try {
        secretFromJson('ms-course', '{"DB_PASSWORD": s3cr3t');
      } catch (caught) {
        return caught as SecretSourceError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(SecretSourceError);
    expect(error?.message).toBe('Secret ms-course could not be parsed as JSON');
    expect(error?.message).not.toContain('s3cr3t');
    expect(error?.cause).toBeUndefined();
  });
});

describe('importSecrets', () => {
  it('writes the keys of each imported secret into the environment', async () => {
    const env: NodeJS.ProcessEnv = { DB_PASSWORD: 'stale' };

    const imported = await importSecrets({
      env,
      imports: ['memory:ms-course'],
      sources: [memoryStore(STORE)],
    });

    expect(imported).toEqual(['memory:ms-course']);
    expect(env.DB_USERNAME).toBe('course');
    expect(env.DB_PASSWORD).toBe('s3cr3t');
  });

  it('reads the imports that operations adds with NOVA_SECRETS_IMPORT', async () => {
    const env: NodeJS.ProcessEnv = {
      [SECRET_IMPORT_VARIABLE]: 'memory:ms-course',
    };

    await importSecrets({ env, sources: [memoryStore(STORE)] });

    expect(env.DB_USERNAME).toBe('course');
  });

  it('lets the later import win', async () => {
    const env: NodeJS.ProcessEnv = {};

    await importSecrets({
      env,
      imports: ['memory:ms-course', 'memory:ms-course-v2'],
      sources: [memoryStore(STORE)],
    });

    expect(env.DB_PASSWORD).toBe('rotated');
  });

  it('creates each store once and passes it the settings of the service', async () => {
    const store = memoryStore(STORE);

    await importSecrets({
      env: { NOVA_SECRETS_MEMORY_REGION: 'lima' },
      imports: ['memory:ms-course', 'optional:memory:other'],
      sources: [store],
    });

    expect(store.created).toBe(1);
    expect(store.settings?.('nova.secrets.memory.region')).toBe('lima');
  });

  it('without override leaves the original variables alone but still beats what was unfolded', async () => {
    const env: NodeJS.ProcessEnv = {
      DB_PASSWORD: 'from-the-environment',
      DB_USERNAME: 'unfolded',
    };

    await importSecrets(
      {
        env,
        override: false,
        imports: ['memory:ms-course'],
        sources: [memoryStore(STORE)],
      },
      new Set(['DB_PASSWORD']),
    );

    expect(env.DB_PASSWORD).toBe('from-the-environment');
    expect(env.DB_USERNAME).toBe('course');
  });

  it('stops the startup when a required secret is missing, and skips an optional one', async () => {
    await expect(
      importSecrets({
        env: {},
        imports: ['memory:missing'],
        sources: [memoryStore(STORE)],
      }),
    ).rejects.toThrow(
      'Secret memory:missing does not exist; write optional:memory:missing if it may',
    );

    await expect(
      importSecrets({
        env: {},
        imports: ['optional:memory:missing'],
        sources: [memoryStore(STORE)],
      }),
    ).resolves.toEqual([]);
  });

  it('leaves the environment untouched when one of the imports fails', async () => {
    const env: NodeJS.ProcessEnv = {};

    await expect(
      importSecrets({
        env,
        imports: ['memory:ms-course', 'memory:missing'],
        sources: [memoryStore(STORE)],
      }),
    ).rejects.toThrow(SecretSourceError);
    expect(env.DB_PASSWORD).toBeUndefined();
  });

  it('names the package to install when a store is not a dependency', async () => {
    await expect(
      importSecrets({ env: {}, imports: ['key-vault:ms-course'] }),
    ).rejects.toThrow(
      'Secret key-vault:ms-course needs the package @ahincho/nova-nestjs-secrets-key-vault; each store is a dependency',
    );
  });

  // El almacén es dependencia del servicio, no de este paquete: con pnpm solo
  // se encuentra resolviendo desde la carpeta del servicio.
  it('finds the store package installed in the folder of the service', async () => {
    const service = mkdtempSync(join(tmpdir(), 'nova-service-'));
    try {
      const store = join(
        service,
        'node_modules',
        '@ahincho',
        'nova-nestjs-secrets-memory',
      );
      mkdirSync(store, { recursive: true });
      writeFileSync(join(service, 'package.json'), '{"name":"service"}');
      writeFileSync(
        join(store, 'package.json'),
        '{"name":"@ahincho/nova-nestjs-secrets-memory","main":"index.js"}',
      );
      writeFileSync(
        join(store, 'index.js'),
        `exports.secretSourceProvider = { name: 'memory', create: () => ({
           find: (reference) => Promise.resolve({ reference, entries: { DB_PASSWORD: 'installed' } }),
         }) };`,
      );
      const env: NodeJS.ProcessEnv = {};

      await importSecrets({
        env,
        root: service,
        imports: ['memory:ms-course'],
      });

      expect(env.DB_PASSWORD).toBe('installed');
    } finally {
      rmSync(service, { recursive: true, force: true });
    }
  });

  it('does nothing when nothing is imported', async () => {
    await expect(importSecrets({ env: {} })).resolves.toEqual([]);
  });
});
