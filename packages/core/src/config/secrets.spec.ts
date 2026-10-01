import {
  SECRET_VARIABLES_VARIABLE,
  SecretUnfoldError,
  secretVariables,
  unfoldSecrets,
} from './secrets';

function env(entries: Record<string, string>): NodeJS.ProcessEnv {
  return { ...entries };
}

/**
 * La convención de una organización cuya plataforma inyecta cada secreto en una
 * variable `SECRET_*`. Es lo que declararía su perfil: el núcleo no trae
 * ningún prefijo.
 */
const PREFIX = 'SECRET_';

describe('secretVariables', () => {
  // Lo que la plataforma NO puede hacer es traer escrita la lista de secretos
  // de un servicio: enumerarlos acá haría que agregar uno exija publicar una
  // versión del framework.
  it('discovers every variable under the declared prefix', () => {
    const variables = secretVariables({
      prefix: PREFIX,
      env: env({
        SECRET_DB: '{}',
        SECRET_LEGACY: '{}',
        SECRET_ANYTHING_ELSE: '{}',
        DATABASE_URL: 'postgres://x',
      }),
    });

    expect(variables).toEqual([
      'SECRET_DB',
      'SECRET_LEGACY',
      'SECRET_ANYTHING_ELSE',
    ]);
  });

  it('honours a different prefix', () => {
    expect(
      secretVariables({
        prefix: 'VAULT_',
        env: env({ VAULT_DB: '{}', SECRET_DB: '{}' }),
      }),
    ).toEqual(['VAULT_DB']);
  });

  // Adivinar un prefijo sobre un entorno ajeno puede toparse con una variable
  // que se llama así y no trae JSON, y eso corta el arranque. Quien conoce el
  // entorno es la organización.
  it('discovers nothing when no prefix is declared', () => {
    expect(secretVariables({ env: env({ SECRET_DB: '{}' }) })).toEqual([]);
  });

  it('discovers nothing when the convention is turned off', () => {
    expect(
      secretVariables({ prefix: false, env: env({ SECRET_DB: '{}' }) }),
    ).toEqual([]);
  });

  // La salida de emergencia para el secreto que no sigue la convención: quien
  // opera el servicio la agrega a la task definition, sin tocar el código.
  it('takes the variables named at runtime', () => {
    expect(
      secretVariables({
        env: env({
          [SECRET_VARIABLES_VARIABLE]: 'LEGACY_CREDENTIALS, OTHER_ONE',
          LEGACY_CREDENTIALS: '{}',
        }),
      }),
    ).toEqual(['LEGACY_CREDENTIALS', 'OTHER_ONE']);
  });

  it('adds the ones the service declares to the ones it discovers', () => {
    expect(
      secretVariables({
        prefix: PREFIX,
        variables: ['LEGACY_CREDENTIALS'],
        env: env({ SECRET_DB: '{}' }),
      }),
    ).toEqual(['LEGACY_CREDENTIALS', 'SECRET_DB']);
  });

  it('names a variable once even when every source lists it', () => {
    expect(
      secretVariables({
        prefix: PREFIX,
        variables: ['SECRET_DB'],
        env: env({
          [SECRET_VARIABLES_VARIABLE]: 'SECRET_DB',
          SECRET_DB: '{}',
        }),
      }),
    ).toEqual(['SECRET_DB']);
  });
});

describe('unfoldSecrets', () => {
  it('spreads the keys of the secret as plain variables', () => {
    const environment = env({
      SECRET_DB: JSON.stringify({
        DB_HOST: 'academic.internal',
        DB_PORT: 5432,
        DB_SSL: true,
      }),
    });

    expect(unfoldSecrets({ prefix: PREFIX, env: environment })).toEqual([
      'SECRET_DB',
    ]);
    expect(environment['DB_HOST']).toBe('academic.internal');
    // Todo llega como texto: es lo que un proceso recibe por el entorno, y lo
    // que los esquemas de configuración esperan convertir.
    expect(environment['DB_PORT']).toBe('5432');
    expect(environment['DB_SSL']).toBe('true');
  });

  // Un secreto ausente no falla: es lo que permite que una corrida local y los
  // tests anden con sus propias variables.
  it('says nothing about a variable that is absent or blank', () => {
    expect(unfoldSecrets({ prefix: PREFIX, env: env({}) })).toEqual([]);
    expect(
      unfoldSecrets({ prefix: PREFIX, env: env({ SECRET_DB: '   ' }) }),
    ).toEqual([]);
  });

  // Lo contrario de lo intuitivo y lo correcto: dejarlo pasar produce un
  // contenedor que muere sin decir por qué.
  it('stops the boot when the secret is not JSON', () => {
    expect(() =>
      unfoldSecrets({ prefix: PREFIX, env: env({ SECRET_DB: 'not json' }) }),
    ).toThrow(SecretUnfoldError);
  });

  it('stops the boot when the secret is not a JSON object', () => {
    expect(() =>
      unfoldSecrets({ prefix: PREFIX, env: env({ SECRET_DB: '["a"]' }) }),
    ).toThrow(SecretUnfoldError);
    expect(() =>
      unfoldSecrets({ prefix: PREFIX, env: env({ SECRET_DB: '"a"' }) }),
    ).toThrow(SecretUnfoldError);
  });

  // El valor de un secreto no llega a un log ni siquiera dentro de un catch, y
  // `JSON.parse` cita el texto que no pudo leer.
  it('names the variable and never its contents', () => {
    const secret = 'super-secret-password';

    try {
      unfoldSecrets({ prefix: PREFIX, env: env({ SECRET_DB: secret }) });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('SECRET_DB');
      expect(message).not.toContain(secret);
    }
  });

  it('lets the secret win over a loose variable of the same name', () => {
    const environment = env({
      DB_HOST: 'localhost',
      SECRET_DB: JSON.stringify({ DB_HOST: 'academic.internal' }),
    });

    unfoldSecrets({ prefix: PREFIX, env: environment });

    expect(environment['DB_HOST']).toBe('academic.internal');
  });

  it('leaves the loose variable alone when asked not to override', () => {
    const environment = env({
      DB_HOST: 'localhost',
      SECRET_DB: JSON.stringify({ DB_HOST: 'academic.internal' }),
    });

    unfoldSecrets({ prefix: PREFIX, env: environment, override: false });

    expect(environment['DB_HOST']).toBe('localhost');
  });

  // Convertirlos daría "[object Object]", que resolvería cualquier validación
  // llevando basura.
  it('drops the values that are not scalars', () => {
    const environment = env({
      SECRET_DB: JSON.stringify({
        DB_HOST: 'academic.internal',
        DB_OPTIONS: { ssl: true },
        DB_REPLICAS: ['a', 'b'],
        DB_UNSET: null,
      }),
    });

    unfoldSecrets({ prefix: PREFIX, env: environment });

    expect(environment['DB_HOST']).toBe('academic.internal');
    expect(environment['DB_OPTIONS']).toBeUndefined();
    expect(environment['DB_REPLICAS']).toBeUndefined();
    expect(environment['DB_UNSET']).toBeUndefined();
  });

  it('unfolds every secret it was given, not just the first', () => {
    const environment = env({
      SECRET_DB: JSON.stringify({ DB_HOST: 'a' }),
      SECRET_LEGACY: JSON.stringify({ LEGACY_USER: 'b' }),
    });

    expect(unfoldSecrets({ prefix: PREFIX, env: environment })).toEqual([
      'SECRET_DB',
      'SECRET_LEGACY',
    ]);
    expect(environment['DB_HOST']).toBe('a');
    expect(environment['LEGACY_USER']).toBe('b');
  });
});
