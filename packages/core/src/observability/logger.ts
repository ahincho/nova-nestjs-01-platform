import { inspect } from 'node:util';
import { stdSerializers } from 'pino';

/**
 * Headers that must never reach a log.
 *
 * `authorization` carries a live token: a log index is read by more people than
 * the database it protects, and a token pasted into a search box is a working
 * credential. The rest are the same problem in other clothes.
 */
export const SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
] as const;

/** Cabecera de la que sale el id de correlación cuando el llamador lo manda. */
export const DEFAULT_REQUEST_ID_HEADER = 'x-request-id';

export type RequestLoggerOptions = {
  /** pino level. Defaults to `info`. */
  readonly level?: string;

  /**
   * Human-readable output for local development. Never turn it on in a
   * container: the log collector expects one JSON document per line.
   */
  readonly pretty?: boolean;

  /** Extra headers to redact, on top of {@link SENSITIVE_HEADERS}. */
  readonly redactHeaders?: readonly string[];

  /**
   * Cabecera de la que se lee el id de correlación, o varias en orden: gana la
   * primera que traiga un valor. Por defecto {@link DEFAULT_REQUEST_ID_HEADER}.
   */
  readonly requestIdHeader?: string | readonly string[];

  /**
   * Fuente alternativa del id, consultada sólo cuando la petición no trae la
   * cabecera. Existe para un servicio que lo saque de otro lado; el contexto de
   * la plataforma no la necesita, porque para cuando pino mira ya escribió
   * `req.id`.
   */
  readonly requestId?: () => string | undefined;

  /**
   * Dónde escribe pino. Por defecto la salida estándar, que es de donde el
   * recolector de un contenedor toma los documentos.
   *
   * Cambiarla es para el caso raro -- escribir a un archivo, a un socket -- y
   * para poder leer lo que se emitió desde un test: pino escribe al descriptor
   * 1 directamente, así que sustituir `process.stdout.write` no lo intercepta.
   */
  readonly destination?: LogDestination;
};

/** Lo mínimo que pino necesita de un destino. */
export type LogDestination = { write(chunk: string): void };

/**
 * The shape `nestjs-pino` expects, declared structurally.
 *
 * Se declara en vez de importarse para no atar la firma pública de este paquete
 * a la versión de `pino-http` que resuelva el consumidor.
 */
export type RequestLoggerParams = {
  readonly pinoHttp:
    Record<string, unknown> | [Record<string, unknown>, LogDestination];
};

type RequestLike = {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
};

type ResponseLike = {
  readonly statusCode?: number;
  readonly err?: unknown;
};

type SerializedError = {
  readonly type?: unknown;
  readonly message?: unknown;
  readonly stack?: unknown;
  readonly code?: unknown;
};

/**
 * La forma de `err` en el log: el tipo, el mensaje, el stack y, si lo trae, el
 * código del sistema. Nada más.
 *
 * El serializador estándar de pino copia además cada propiedad enumerable del
 * error, y en un índice eso rompe de dos maneras. Una `HttpException` trae
 * `response`, que en unas es un texto y en otras un objeto: el índice fija el
 * tipo del campo con la primera línea que ve y rechaza entera cada línea que
 * traiga el otro, así que el error se pierde justo cuando pasa. Y un error
 * puede cargar lo que nunca debió llegar al log: el `body` de un
 * `UpstreamHttpError` es el cuerpo de error del upstream, con los datos de la
 * persona.
 *
 * El mensaje y el stack siguen trayendo las causas encadenadas: eso lo arma el
 * serializador estándar, y esta función parte de lo que él devuelve.
 */
export function serializeError(value: unknown): unknown {
  // Con `wrapSerializers`, pino-http ya lo pasó por el estándar antes de
  // llegar acá. Un Error crudo es el caso de usar estas opciones sin él.
  const serialized: unknown =
    value instanceof Error ? stdSerializers.err(value) : value;
  const error =
    typeof serialized === 'object' && serialized !== null
      ? (serialized as SerializedError)
      : undefined;

  // Lo que no es un error -un texto lanzado, un objeto cualquiera- queda como
  // mensaje, para que `err` tenga siempre la misma forma.
  if (typeof error?.message !== 'string') {
    return {
      message:
        typeof serialized === 'string'
          ? serialized
          : inspect(serialized, { depth: 2, breakLength: Infinity }),
    };
  }

  const { type, message, stack, code } = error;

  return {
    ...(typeof type === 'string' ? { type } : {}),
    message,
    ...(typeof stack === 'string' ? { stack } : {}),
    // Como texto siempre: hay librerías que lo dan como número, y un campo con
    // dos tipos es el mismo problema de arriba.
    ...(typeof code === 'string' || typeof code === 'number'
      ? { code: String(code) }
      : {}),
  };
}

/**
 * La línea de la petición, sin el error que pino-http inventa.
 *
 * pino-http arma un `Error('failed with status code 502')` para todo 5xx que no
 * le trae uno, con un stack que apunta a su propio código. No dice nada que el
 * status no diga, y el error de verdad ya lo registró el filtro de errores con
 * el mismo id: la línea de la petición es de tráfico, no de fallos. Un error
 * real del socket, que sí llega hasta acá, se conserva.
 */
function withoutInventedError(
  _request: unknown,
  response: ResponseLike,
  error: unknown,
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const invented =
    response.err === undefined &&
    error instanceof Error &&
    error.message === `failed with status code ${response.statusCode}`;

  return invented
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'err'))
    : { ...value };
}

function redactionPaths(extra: readonly string[]): string[] {
  const headers = [...SENSITIVE_HEADERS, ...extra];

  // Both directions are listed because pino cannot know which of the two a
  // given entry came from, and a token redacted on the way in that reappears on
  // the way out has not been redacted.
  return headers.flatMap((header) => [
    `req.headers["${header}"]`,
    `res.headers["${header}"]`,
  ]);
}

function headerValue(
  request: RequestLike | undefined,
  name: string,
): string | undefined {
  const value = request?.headers?.[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === '' ? undefined : first;
}

/**
 * Builds the pino options every Nova service logs through.
 *
 * @example
 * LoggerModule.forRoot(createRequestLoggerOptions({ level: 'debug' }));
 */
export function createRequestLoggerOptions(
  options: RequestLoggerOptions = {},
): RequestLoggerParams {
  const idHeaders =
    typeof options.requestIdHeader === 'string'
      ? [options.requestIdHeader]
      : (options.requestIdHeader ?? [DEFAULT_REQUEST_ID_HEADER]);

  const pinoHttp: Record<string, unknown> = {
    level: options.level ?? 'info',
    redact: {
      paths: redactionPaths(options.redactHeaders ?? []),
      censor: '[redacted]',
    },
    // Se lee de la petición y no del contexto a propósito, para que el id no
    // dependa de qué middleware corrió primero.
    //
    // pino-http hace `req.id = req.id || genReqId(req, res)`, así que cuando el
    // contexto de la plataforma ya escribió `req.id` esto ni se llama y el id es
    // uno solo. Si pino llegara a mirar primero, leer las mismas cabeceras en
    // el mismo orden da el mismo valor, y el contexto adopta el `req.id` que
    // encuentre. Las dos direcciones convergen.
    genReqId: (request?: RequestLike): string =>
      idHeaders
        .map((name) => headerValue(request, name))
        .find((value) => value !== undefined) ??
      options.requestId?.() ??
      crypto.randomUUID(),
    // Sin esto un Error logueado sale como `{}`: sus propiedades no son
    // enumerables, así que el serializador es lo único que rescata `message` y
    // `stack`. Por qué no el estándar a secas, en `serializeError`.
    serializers: { err: serializeError },
    wrapSerializers: true,
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request errored',
    customErrorObject: withoutInventedError,
  };

  if (options.pretty === true) {
    pinoHttp['transport'] = {
      target: 'pino-pretty',
      options: {
        singleLine: true,
        colorize: true,
        translateTime: 'SYS:standard',
      },
    };
  }

  if (options.destination) {
    return { pinoHttp: [pinoHttp, options.destination] };
  }

  return { pinoHttp };
}
