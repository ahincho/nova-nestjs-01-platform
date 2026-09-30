import {
  Catch,
  HttpException,
  Inject,
  Logger,
  Optional,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ApiErrorItem } from '../../api-standard';
import {
  ApplicationErrorType,
  InfrastructureError,
  InfrastructureErrorType,
  Layer,
  NovaError,
  PlatformError,
  PlatformErrorType,
  type ErrorPorts,
  type ErrorReply,
  type ErrorType,
  type FieldError,
  type LayeredError,
} from '../../errors';
import { UpstreamHttpError } from '../../http/upstream-http.error';
import { currentRequestId } from '../../observability/request-context.storage';
import { ValidationException } from '../exceptions/validation.exception';
import {
  API_STANDARD_OPTIONS,
  ERROR_PORTS,
  resolveErrorPorts,
  type ResolvedApiStandardOptions,
} from '../tokens';

/**
 * The slice of the platform response object this filter uses.
 *
 * Typed structurally so the package does not depend on `@types/express`: the
 * same filter works under Fastify.
 */
type HttpResponseLike = {
  setHeader?(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
};

type HttpRequestLike = {
  readonly id?: string;
  readonly url?: string;
  readonly method?: string;
};

type Classified = {
  readonly error: LayeredError;
  readonly status: number;
};

// Cómo se lee una excepción propia del framework (ADR-031): por su status. Un
// 4xx es de `application`, con el tipo de la fila que tiene ese status; un 404
// o un 405 no tienen fila y quedan sin tipo. Un 5xx sigue la misma tabla: los
// 502 y 504 que lanza el cliente HTTP son fallas de una dependencia, y
// contarlos como `application` los escondería de la alerta que existe para eso.
const APPLICATION_TYPES: Readonly<Record<number, ApplicationErrorType>> = {
  400: ApplicationErrorType.INVALID_INPUT,
  401: ApplicationErrorType.UNAUTHENTICATED,
  403: ApplicationErrorType.FORBIDDEN,
  409: ApplicationErrorType.CONFLICT,
  422: ApplicationErrorType.UNPROCESSABLE,
  429: ApplicationErrorType.RATE_LIMITED,
};

const INFRASTRUCTURE_TYPES: Readonly<Record<number, InfrastructureErrorType>> =
  {
    502: InfrastructureErrorType.BAD_GATEWAY,
    503: InfrastructureErrorType.UNAVAILABLE,
    504: InfrastructureErrorType.TIMEOUT,
  };

// Hasta cinco causas: alcanza para cualquier cadena real y corta un ciclo.
const MAX_CAUSES = 5;

function classifyStatus(status: number): {
  readonly layer: Layer;
  readonly type: ErrorType | undefined;
} {
  if (status < 500) {
    return { layer: Layer.APPLICATION, type: APPLICATION_TYPES[status] };
  }

  const type = INFRASTRUCTURE_TYPES[status];

  return type === undefined
    ? { layer: Layer.PLATFORM, type: PlatformErrorType.INTERNAL }
    : { layer: Layer.INFRASTRUCTURE, type };
}

function messageOf(exception: HttpException): string {
  const body: unknown = exception.getResponse();

  if (typeof body === 'string') {
    return body;
  }

  if (typeof body === 'object' && body !== null) {
    const { message } = body as { message?: unknown };

    if (Array.isArray(message)) {
      return message.join(', ');
    }

    if (typeof message === 'string') {
      return message;
    }
  }

  return exception.message;
}

// `instanceof` sobre la base genérica deja el tipo en `NovaError<any>`; la
// guarda lo deja en los tipos de la tabla, que es lo que de verdad es.
function isNovaError(value: unknown): value is NovaError {
  return value instanceof NovaError;
}

// La fábrica de validación siempre nombra el campo. Un `ValidationException`
// armado a mano puede traer una entrada sin él, y sale con el nombre vacío.
function toFieldError(item: ApiErrorItem): FieldError {
  return { field: item.field ?? '', code: item.code, message: item.message };
}

/**
 * Un `UpstreamHttpError` que nadie tradujo: el servicio pidió el error crudo con
 * `forwardError` y lo dejó escapar. Se lee igual que cuando el cliente lo
 * traduce solo -un timeout es 504, todo lo demás 502-, para que la misma
 * respuesta del upstream conteste lo mismo con o sin `forwardError`.
 */
function upstreamError(exception: UpstreamHttpError): InfrastructureError {
  const type =
    exception.statusCode === 504 || exception.statusCode === 408
      ? InfrastructureErrorType.TIMEOUT
      : InfrastructureErrorType.BAD_GATEWAY;

  // Sin proveedor: el error no lo trae. El cliente HTTP ya registró la URL en
  // su propia línea, con el mismo id de petición.
  return new InfrastructureError(type, undefined, {
    message: exception.message,
    cause: exception,
  });
}

function platformError(exception: unknown): PlatformError {
  return PlatformError.internal(
    exception instanceof Error ? exception.message : 'Unhandled exception',
    { cause: exception },
  );
}

/**
 * La excepción y sus causas, como las escribe Java: el stack de cada una, las
 * causas precedidas de `Caused by:`.
 */
function stackOf(exception: unknown): string | undefined {
  const stacks: string[] = [];
  let current: unknown = exception;

  for (
    let depth = 0;
    depth <= MAX_CAUSES && current instanceof Error;
    depth += 1
  ) {
    const stack = current.stack ?? `${current.name}: ${current.message}`;
    stacks.push(depth === 0 ? stack : `Caused by: ${stack}`);
    current = current.cause;
  }

  return stacks.length === 0 ? undefined : stacks.join('\n');
}

/**
 * Catches every unhandled exception and answers through the error ports of
 * ADR-031.
 *
 * Un error de Nova toma su status del `ErrorStatusMapper`. Una excepción del
 * framework conserva el suyo, un `UpstreamHttpError` es de `infrastructure`, y
 * cualquier otra cosa es de `platform` y sale como 500. Después `ErrorCatalog`
 * decide el código y el mensaje, y `ErrorSerializer` el cuerpo y las cabeceras.
 *
 * Logs through Nest's own `Logger`, so an application that installed a logger
 * with `app.useLogger()` gets these entries in its own format without this
 * package depending on any logging library.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private readonly ports: ErrorPorts;

  constructor(
    @Inject(API_STANDARD_OPTIONS)
    options: ResolvedApiStandardOptions,
    @Optional()
    @Inject(ERROR_PORTS)
    ports?: ErrorPorts,
  ) {
    // Sin el token -un filtro armado a mano con `new`- quedan los puertos de
    // Nova con el mensaje de las opciones, que es lo que hacía antes.
    this.ports = ports ?? resolveErrorPorts({}, options.internalErrorMessage);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // Nothing to answer on. Reported rather than swallowed, because a
      // silent drop here looks like the handler simply never ran.
      this.logger.error(
        'Unhandled exception outside an HTTP context',
        exception instanceof Error ? exception.stack : undefined,
      );
      return;
    }

    const context = host.switchToHttp();
    const request = context.getRequest<HttpRequestLike>();
    const { error, status } = this.classify(exception);
    const reply: ErrorReply = {
      ...this.ports.catalog.describe(error, status),
      status,
      // El que el error tomó al nacer. Si nació fuera de una petición, el de la
      // que se está contestando, que el middleware también deja en `req.id`.
      traceId: error.traceId ?? currentRequestId() ?? request.id,
    };
    const { headers, body } = this.ports.serializer.serialize(error, reply);

    this.log(exception, error, reply, request);

    const response = context.getResponse<HttpResponseLike>();

    for (const [name, value] of Object.entries(headers)) {
      response.setHeader?.(name, value);
    }

    response.status(status).json(body);
  }

  private classify(exception: unknown): Classified {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    let error: NovaError;

    if (isNovaError(exception)) {
      error = exception;
    } else if (exception instanceof UpstreamHttpError) {
      error = upstreamError(exception);
    } else {
      error = platformError(exception);
    }

    return { error, status: this.ports.statusMapper.statusOf(error) };
  }

  /**
   * Una excepción del framework, leída sin cambiar lo que contestaba: su status,
   * su `errorCode` -que el catálogo de Nova muestra sólo en un 4xx-, su mensaje
   * y, si es de validación, una entrada por campo.
   */
  private fromHttpException(exception: HttpException): Classified {
    const status = exception.getStatus();

    return {
      status,
      error: {
        ...classifyStatus(status),
        code: exception.errorCode,
        message: messageOf(exception),
        fieldErrors:
          exception instanceof ValidationException
            ? exception.validationErrors.map(toFieldError)
            : [],
        cause: exception,
        traceId: currentRequestId(),
      },
    };
  }

  private log(
    exception: unknown,
    error: LayeredError,
    reply: ErrorReply,
    request: HttpRequestLike,
  ): void {
    // Campos y no texto: `layer` es lo que deja alertar sobre `infrastructure`
    // sin que un 404 de negocio ensucie la señal, y `traceId` es el mismo que el
    // cliente ve en `metadata.traceId`. Un campo sin valor no sale en la línea.
    const detail = {
      traceId: reply.traceId,
      layer: error.layer,
      type: error.type,
      code: reply.code,
      upstream: error.upstream,
      status: reply.status,
      message: error.message,
      fieldErrors: error.fieldErrors.length > 0 ? error.fieldErrors : undefined,
      requestId: request.id,
      method: request.method,
      path: request.url,
    };

    // A 4xx is the client being told it got something wrong, not a fault of
    // ours. Logging it at error level is what buries the 5xx that matter.
    if (reply.status >= 500) {
      this.logger.error(detail, stackOf(exception));
      return;
    }

    this.logger.warn(detail);
  }
}
