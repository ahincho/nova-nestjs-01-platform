import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import {
  SecretSourceError,
  durationSetting,
  secretFromJson,
  type Secret,
  type SecretSettings,
  type SecretSource,
  type SecretSourceProvider,
} from '@ahincho/nova-nestjs';

/** El nombre con que se pide: `aws-secrets-manager:<nombre o ARN>`. */
export const AWS_SECRETS_MANAGER_SOURCE = 'aws-secrets-manager';

const PREFIX = 'nova.secrets.aws-secrets-manager.';
const DEFAULT_TIMEOUT_MS = 5000;

/** Lo único que la fuente usa del cliente, para que una prueba lo reemplace. */
export type SecretsManagerSender = Pick<SecretsManagerClient, 'send'>;

type AwsSettings = {
  readonly region: string | undefined;
  readonly endpoint: string | undefined;
  readonly timeoutMs: number;
};

function invalid(reason: string): SecretSourceError {
  return new SecretSourceError('source aws-secrets-manager', reason);
}

/**
 * La configuración, con las mismas claves que en Java. La región y las
 * credenciales siguen la cadena del SDK: `AWS_REGION` y, dentro de ECS, el rol
 * de la tarea.
 */
function awsSettings(settings: SecretSettings): AwsSettings {
  const endpoint = settings(`${PREFIX}endpoint`);
  if (endpoint !== undefined) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw invalid('has an endpoint that is not a URI');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw invalid('needs an http or https endpoint');
    }
  }
  return {
    region: settings(`${PREFIX}region`) ?? settings('aws.region'),
    endpoint,
    timeoutMs: durationSetting(
      settings,
      `${PREFIX}timeout`,
      DEFAULT_TIMEOUT_MS,
    ),
  };
}

/**
 * AWS Secrets Manager, con `GetSecretValue`. Abre el `SecretString` con las
 * mismas reglas que el JSON que ECS inyecta en el entorno, así que las dos rutas
 * producen las mismas variables (ADR-042, «El JSON de AWS»).
 */
export class AwsSecretsManagerSecretSource implements SecretSource {
  constructor(
    private readonly client: SecretsManagerSender,
    private readonly timeoutMs: number,
  ) {}

  async find(reference: string): Promise<Secret | undefined> {
    if (reference.trim() === '') {
      throw new SecretSourceError(reference, 'is not a secret name or ARN');
    }
    let response: GetSecretValueCommandOutput;
    try {
      response = await this.client.send(
        new GetSecretValueCommand({ SecretId: reference }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error) {
      if (named(error) === 'ResourceNotFoundException') {
        return undefined;
      }
      throw this.failure(reference, error);
    }
    if (response.SecretString !== undefined) {
      return secretFromJson(reference, response.SecretString);
    }
    throw new SecretSourceError(
      reference,
      'is stored as binary, which cannot be opened as properties',
    );
  }

  private failure(reference: string, error: unknown): SecretSourceError {
    const name = named(error);
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new SecretSourceError(
        reference,
        `could not be read: AWS Secrets Manager did not answer within ${this.timeoutMs} ms`,
      );
    }
    if (name === 'AccessDeniedException' || status === 403) {
      return new SecretSourceError(
        reference,
        `was refused by AWS Secrets Manager (${name ?? `status ${status}`}): the role cannot read it`,
      );
    }
    if (name === 'CredentialsProviderError') {
      return new SecretSourceError(
        reference,
        'could not be read: no AWS credentials were found in the environment, a profile or the task role',
      );
    }
    if (error instanceof Error && /region is missing/i.test(error.message)) {
      return invalid(
        'needs a region: set nova.secrets.aws-secrets-manager.region or AWS_REGION',
      );
    }
    if (status !== undefined) {
      return new SecretSourceError(
        reference,
        `could not be read from AWS Secrets Manager (${name ?? `status ${status}`})`,
      );
    }
    return new SecretSourceError(
      reference,
      'could not be read: AWS Secrets Manager is not reachable',
      { cause: error },
    );
  }
}

function named(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/**
 * La fuente `aws-secrets-manager`. `core` la encuentra sola cuando un servicio
 * pide `aws-secrets-manager:<nombre o ARN>`, porque este paquete la exporta con
 * este nombre.
 */
export const secretSourceProvider: SecretSourceProvider = {
  name: AWS_SECRETS_MANAGER_SOURCE,
  create: (settings) => {
    const aws = awsSettings(settings);
    const client = new SecretsManagerClient({
      ...(aws.region === undefined ? {} : { region: aws.region }),
      ...(aws.endpoint === undefined ? {} : { endpoint: aws.endpoint }),
      // Un solo intento: sin reintentos, como el cliente HTTP de la plataforma (ADR-029).
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: aws.timeoutMs,
        requestTimeout: aws.timeoutMs,
      },
    });
    return new AwsSecretsManagerSecretSource(client, aws.timeoutMs);
  },
};
