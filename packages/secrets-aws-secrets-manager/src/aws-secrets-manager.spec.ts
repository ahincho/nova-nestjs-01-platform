import {
  CreateSecretCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { importSecrets, secretSettings } from '@ahincho/nova-nestjs';
import {
  GenericContainer,
  getContainerRuntimeClient,
  Wait,
} from 'testcontainers';
import {
  AwsSecretsManagerSecretSource,
  secretSourceProvider,
  type SecretsManagerSender,
} from './aws-secrets-manager';

/** Un cliente que contesta lo que se le pida, para probar cada caso sin AWS. */
function answering(answer: () => Promise<unknown>): SecretsManagerSender {
  return { send: (() => answer()) as SecretsManagerSender['send'] };
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

function failing(name: string, status?: number): SecretsManagerSender {
  const error = Object.assign(new Error(`${name} from AWS`), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });
  return answering(() => Promise.reject(error));
}

const DB_JSON = '{"DB_USERNAME":"course","DB_PASSWORD":"s3cr3t","PORT":5432}';

describe('the AWS Secrets Manager secret source', () => {
  it('opens the SecretString with the same rules as the environment', async () => {
    const secretSource = new AwsSecretsManagerSecretSource(
      answering(() => Promise.resolve({ SecretString: DB_JSON })),
      5000,
    );

    await expect(secretSource.find('prod/ms-course/db')).resolves.toEqual({
      reference: 'prod/ms-course/db',
      entries: { DB_USERNAME: 'course', DB_PASSWORD: 's3cr3t', PORT: '5432' },
    });
  });

  it('answers a secret that does not exist as missing', async () => {
    await expect(
      new AwsSecretsManagerSecretSource(
        failing('ResourceNotFoundException', 400),
        5000,
      ).find('nope'),
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      failing('AccessDeniedException', 400),
      'was refused by AWS Secrets Manager (AccessDeniedException): the role cannot read it',
    ],
    [
      failing('InternalServiceError', 500),
      'could not be read from AWS Secrets Manager (InternalServiceError)',
    ],
    [
      failing('CredentialsProviderError'),
      'could not be read: no AWS credentials were found in the environment, a profile or the task role',
    ],
    [
      failing('TimeoutError'),
      'could not be read: AWS Secrets Manager did not answer within 5000 ms',
    ],
    [
      failing('Error'),
      'could not be read: AWS Secrets Manager is not reachable',
    ],
  ])('says what went wrong (%#)', async (client, message) => {
    await expect(
      new AwsSecretsManagerSecretSource(client, 5000).find('db'),
    ).rejects.toThrow(`Secret db ${message}`);
  });

  it('asks for a region when the SDK has none', async () => {
    await expect(
      new AwsSecretsManagerSecretSource(
        answering(() => Promise.reject(new Error('Region is missing'))),
        5000,
      ).find('db'),
    ).rejects.toThrow(
      'Secret source aws-secrets-manager needs a region: set nova.secrets.aws-secrets-manager.region or AWS_REGION',
    );
  });

  it('does not open a binary secret, and never quotes a broken one', async () => {
    await expect(
      new AwsSecretsManagerSecretSource(
        answering(() => Promise.resolve({ SecretBinary: new Uint8Array([1]) })),
        5000,
      ).find('db'),
    ).rejects.toThrow(
      'Secret db is stored as binary, which cannot be opened as properties',
    );

    const error = await rejection(
      new AwsSecretsManagerSecretSource(
        answering(() =>
          Promise.resolve({ SecretString: '{"DB_PASSWORD": s3cr3t' }),
        ),
        5000,
      ).find('db'),
    );
    expect(error.message).toBe('Secret db could not be parsed as JSON');
    expect(error.message).not.toContain('s3cr3t');
  });

  it('rejects a blank reference', async () => {
    await expect(
      new AwsSecretsManagerSecretSource(
        answering(() => Promise.resolve({})),
        5000,
      ).find(' '),
    ).rejects.toThrow('is not a secret name or ARN');
  });

  it.each([
    [
      { 'nova.secrets.aws-secrets-manager.endpoint': 'not a url' },
      'has an endpoint that is not a URI',
    ],
    [
      { 'nova.secrets.aws-secrets-manager.endpoint': 'ftp://moto' },
      'needs an http or https endpoint',
    ],
  ])('names what is wrong with its settings: %j', (values, message) => {
    expect(() =>
      secretSourceProvider.create(secretSettings({}, values)),
    ).toThrow(`Secret source aws-secrets-manager ${message}`);
  });

  it('creates a client from the settings of the service', () => {
    expect(
      secretSourceProvider.create(
        secretSettings({
          AWS_REGION: 'us-east-1',
          NOVA_SECRETS_AWS_SECRETS_MANAGER_ENDPOINT: 'http://127.0.0.1:5000',
          NOVA_SECRETS_AWS_SECRETS_MANAGER_TIMEOUT: '2s',
        }),
      ),
    ).toBeInstanceOf(AwsSecretsManagerSecretSource);
  });
});

// De punta a punta, contra Moto, el emulador de AWS. Se salta si la máquina no tiene Docker.
describe('a real AWS Secrets Manager API', () => {
  let docker = false;
  let container: Awaited<ReturnType<GenericContainer['start']>> | undefined;
  let endpoint: string;

  beforeAll(async () => {
    docker = await getContainerRuntimeClient().then(
      () => true,
      () => false,
    );
    if (!docker) {
      return;
    }
    container = await new GenericContainer('motoserver/moto:5.2.3')
      .withExposedPorts(5000)
      .withWaitStrategy(Wait.forHttp('/moto-api/', 5000))
      .start();
    endpoint = `http://${container.getHost()}:${container.getMappedPort(5000)}`;
    const setup = new SecretsManagerClient({
      region: 'us-east-1',
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await setup.send(
      new CreateSecretCommand({
        Name: 'prod/plaza-bff/db',
        SecretString: DB_JSON,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads the secret into the environment as a service does', async (ctx) => {
    if (!docker) {
      ctx.skip();
    }
    // Las credenciales las lee la cadena del SDK del entorno del proceso, como en ECS.
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
    const env: NodeJS.ProcessEnv = {
      AWS_REGION: 'us-east-1',
      NOVA_SECRETS_AWS_SECRETS_MANAGER_ENDPOINT: endpoint,
      NOVA_SECRETS_IMPORT:
        'aws-secrets-manager:prod/plaza-bff/db, optional:aws-secrets-manager:not-there',
    };

    const imported = await importSecrets({
      env,
      sources: [secretSourceProvider],
    });

    expect(imported).toEqual(['aws-secrets-manager:prod/plaza-bff/db']);
    expect(env.DB_PASSWORD).toBe('s3cr3t');
    expect(env.PORT).toBe('5432');
  });
});
