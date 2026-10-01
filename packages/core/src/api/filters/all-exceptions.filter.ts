import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  NovaEnvelopeStandard,
  errorItem,
  type ApiFailure,
  type ApiFailureItem,
  type ApiFailureKind,
  type ApiStandard,
  type ApiWire,
} from '../../api-standard';
import {
  ApplicationErrorType,
  InfrastructureError,
  InfrastructureErrorType,
  Layer,
  NovaError,
  NovaErrorCatalog,
  PlatformError,
  PlatformErrorType,
  type ErrorCatalog,
  type ErrorDescription,
  type ErrorPorts,
  type ErrorType,
  type FieldError,
  type LayeredError,
  type SanitizedError,
} from '../../errors';
import { UpstreamException } from '../../http/upstream-failure';
import { currentRequestId } from '../../observability/request-context.storage';
import {
  ValidationException,
  type ValidationViolation,
} from '../exceptions/validation.exception';
import {
  API_STANDARD,
  API_STANDARD_OPTIONS,
  ERROR_PORTS,
  resolveErrorPorts,
  type ResolvedApiStandardOptions,
} from '../tokens';

/**
 * The slice of the platform response object this filter uses.
 *
 * Typed structurally so the package does not depend on `@types/express`.
 */
type HttpResponseLike = {
  status(code: number): { json(body: unknown): unknown };
  setHeader?(name: string, value: string): unknown;
};

type HttpRequestLike = {
  readonly id?: string;
  readonly url?: string;
  readonly method?: string;
};

/**
 * Lo que el filtro sabe de una excepción una vez leída.
 *
 * `error` es el modelo completo, con el proveedor y la causa: sólo el log lo ve
 * entero. Lo que llega a los puertos sale de acá ya saneado.
 */
type Classified = {
  readonly error: LayeredError;
  readonly status: number;
  readonly kind: ApiFailureKind;
  /**
   * Lo que el error puede decir con sus palabras si es un 4xx. Ausente cuando no
   * trae un mensaje propio -una excepción del framework sin mensaje- y siempre
   * en un 5xx.
   */
  readonly ownMessage: string | undefined;
};

// Cómo se lee una excepción propia del framework (ADR-031): por su status. Un
// 4xx es de `application`, con el tipo de la fila que tiene ese status; un 404
// o un 405 no tienen fila y quedan sin tipo. Un 5xx sigue la misma tabla: los
// 502, 503 y 504 son fallas de una dependencia, y contarlos como `application`
// los escondería de la alerta que existe para eso; cualquier otro 5xx es del
// propio servicio.
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

// El catálogo de respaldo: el de Nova, para cuando ni el servicio ni el estándar
// activo traen uno.
const NOVA_CATALOG = new NovaErrorCatalog();

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

/**
 * Si la capa es de las que despiertan a alguien: `infrastructure` y `platform`
 * son incidentes; `domain` y `application` son esperados (ADR-031).
 */
function isIncident(layer: Layer): boolean {
  return layer === Layer.INFRASTRUCTURE || layer === Layer.PLATFORM;
}

/**
 * El texto que NestJS le pone a una excepción a la que nadie le dio un mensaje:
 * el nombre de su status, `Not Found`, `Forbidden`.
 */
function frameworkDefaultOf(status: number): string | undefined {
  const name = (HttpStatus as unknown as Record<number, string | undefined>)[
    status
  ];

  return name
    ?.split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * El mensaje de una excepción del framework, tal como lo escribió quien la
 * lanzó. `undefined` cuando no escribió ninguno, que es cuando el mensaje es el
 * que NestJS pone solo: ahí el catálogo pone el de su status (ADR-031).
 */
function ownMessageOf(
  exception: HttpException,
  status: number,
): string | undefined {
  const body: unknown = exception.getResponse();
  let message: string | undefined;

  if (typeof body === 'string') {
    message = body;
  } else if (typeof body === 'object' && body !== null) {
    const { message: inBody } = body as { message?: unknown };

    if (Array.isArray(inBody)) {
      message = inBody.join(', ');
    } else if (typeof inBody === 'string') {
      message = inBody;
    }
  }

  return message === undefined ||
    message.trim() === '' ||
    message === frameworkDefaultOf(status)
    ? undefined
    : message;
}

// `instanceof` sobre la base genérica deja el tipo en `NovaError<any>`; la
// guarda lo deja en los tipos de la tabla, que es lo que de verdad es.
function isNovaError(value: unknown): value is NovaError {
  return value instanceof NovaError;
}

// Una violación de la entrada, como el campo de un error de Nova. Un campo
// `null` es una restricción que no es de un campo en particular.
function toFieldError(violation: ValidationViolation): FieldError {
  return {
    field: violation.field,
    message: violation.message,
    ...(violation.code === undefined ? {} : { code: violation.code }),
  };
}

function platformError(exception: unknown): PlatformError {
  return PlatformError.internal(
    exception instanceof Error ? exception.message : 'Unhandled exception',
    { cause: exception },
  );
}

/**
 * Los campos que una excepción quiere en su línea de log, si trae alguno.
 *
 * Se leen por su forma y no por su clase, para que este filtro no dependa del
 * módulo que la lanza: el cliente HTTP pone ahí la clasificación del fallo de
 * upstream, y el día que otro módulo necesite lo mismo no hay que tocar el
 * filtro. Lo que llega acá va al log y nunca al cuerpo.
 */
function logFieldsOf(exception: unknown): Record<string, unknown> {
  if (typeof exception !== 'object' || exception === null) {
    return {};
  }

  const { logFields } = exception as { logFields?: unknown };

  return typeof logFields === 'object' && logFields !== null
    ? { ...(logFields as Record<string, unknown>) }
    : {};
}

/**
 * El mensaje de la línea de log: el de la excepción, sin el stack.
 *
 * El stack va en `err`. Pegado al mensaje hacía única cada línea, y agrupar por
 * mensaje en el índice dejaba de servir justo para los errores. El de una
 * excepción de la plataforma es estable por tipo -«Upstream service timed
 * out»-, así que agrupa.
 */
function logMessageOf(exception: unknown): string {
  if (exception instanceof Error && exception.message !== '') {
    return exception.message;
  }

  if (typeof exception === 'string' && exception !== '') {
    return exception;
  }

  return 'Unhandled exception';
}

/**
 * Catches every unhandled exception and answers with the active standard.
 *
 * El reparto es la razón de ser de este filtro. Acá se decide **qué se puede
 * decir**: el status de cada excepción, que un 5xx no lleve ni su mensaje ni su
 * código de dominio ni su proveedor, qué campos fallaron en una validación. Los
 * puertos -el status, el catálogo, el serializador y el estándar- reciben eso ya
 * decidido y sólo le dan forma, así que uno mal escrito no tiene de dónde filtrar
 * lo que este filtro le quitó (ADR-034).
 *
 * El orden es el que lo hace verdad: primero se lee la excepción entera, después
 * se escribe **una sola línea de log** con todo lo que trae -el proveedor, la
 * causa, el mensaje real-, y sólo entonces se llama a los puertos con el fallo
 * saneado (ADR-035).
 *
 * Logs through Nest's own `Logger`, so an application that installed a logger
 * with `app.useLogger()` gets these entries in its own format without this
 * package depending on any logging library.
 *
 * Los argumentos van con la forma de pino -los campos primero, el mensaje
 * después-, que es como los lee el logger de la plataforma. Con la forma del
 * `ConsoleLogger` de Nest, `error(campos, stack)`, pino toma el segundo
 * argumento como mensaje, y el stack terminaba en `msg`.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(
    @Inject(API_STANDARD_OPTIONS)
    private readonly options: ResolvedApiStandardOptions,
    // Opcionales por la misma razón que en el interceptor: instanciarlo a mano
    // sigue contestando con el sobre de Nova y los puertos de Nova.
    @Optional()
    @Inject(API_STANDARD)
    private readonly standard: ApiStandard = new NovaEnvelopeStandard(),
    @Optional()
    @Inject(ERROR_PORTS)
    private readonly ports: ErrorPorts = resolveErrorPorts(),
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // Nothing to answer on. Reported rather than swallowed, because a
      // silent drop here looks like the handler simply never ran.
      this.logger.error(
        { err: exception },
        'Unhandled exception outside an HTTP context',
      );
      return;
    }

    const context = host.switchToHttp();
    const request = context.getRequest<HttpRequestLike>();
    const classified = this.classify(exception);
    const { failure, description } = this.failureOf(classified, request);

    this.log(exception, classified, failure, description, request);

    const wire = this.wireOf(failure);
    const response = context.getResponse<HttpResponseLike>();

    for (const [name, value] of Object.entries(wire.headers ?? {})) {
      response.setHeader?.(name, value);
    }

    // Antes de `json()`: Express sólo pone `application/json` cuando nadie
    // puso otro, así que un `application/problem+json` sobrevive.
    if (wire.contentType !== undefined) {
      response.setHeader?.('Content-Type', wire.contentType);
    }

    response.status(failure.status).json(wire.body);
  }

  private classify(exception: unknown): Classified {
    // Antes que `HttpException`, de la que hereda: un fallo de upstream es de
    // `infrastructure` y nombra al proveedor.
    if (
      exception instanceof UpstreamException &&
      exception.getStatus() >= 500
    ) {
      return this.fromUpstream(exception);
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    const error = isNovaError(exception) ? exception : platformError(exception);
    // Al puerto de status le llega un objeto nuevo con cómo está clasificado, y
    // no el error: devuelve un número, y no necesita el proveedor ni la causa.
    // Pasarle el error dejaría que un mapper propio los leyera igual.
    const status = this.ports.statusMapper.statusOf({
      layer: error.layer,
      type: error.type,
      ...(error.code === undefined ? {} : { code: error.code }),
    });

    return {
      error,
      status,
      kind: status >= 500 ? 'internal' : 'request',
      ownMessage: error.message.trim() === '' ? undefined : error.message,
    };
  }

  /**
   * Un fallo de una llamada saliente, leído como una falla de `infrastructure`
   * con el proveedor que la clasificación ya conoce (ADR-035): el campo
   * `upstream` del log se llena sin que el servicio lance nada. Conserva el
   * status con el que contesta la excepción, que es el que recomienda RFC 9209.
   *
   * Un fallo nuestro antes de salir -una URL mal configurada- es un 500 y sigue
   * siendo de `platform`.
   */
  private fromUpstream(exception: UpstreamException): Classified {
    const status = exception.getStatus();
    const type = INFRASTRUCTURE_TYPES[status];

    return {
      status,
      kind: 'internal',
      ownMessage: undefined,
      error:
        type === undefined
          ? PlatformError.internal(exception.message, { cause: exception })
          : new InfrastructureError(type, exception.failure.upstream, {
              message: exception.message,
              cause: exception,
            }),
    };
  }

  /**
   * Una excepción del framework, leída sin cambiar lo que contestaba: su status,
   * su `errorCode` -que el catálogo muestra sólo en un 4xx-, su mensaje si trae
   * uno propio y, si es de validación, una entrada por campo.
   */
  private fromHttpException(exception: HttpException): Classified {
    const status = exception.getStatus();
    const validation = exception instanceof ValidationException;

    return {
      status,
      kind: validation ? 'validation' : status >= 500 ? 'internal' : 'request',
      ownMessage: validation ? undefined : ownMessageOf(exception, status),
      error: {
        ...classifyStatus(status),
        code: exception.errorCode,
        message: exception.message,
        fieldErrors: validation ? exception.violations.map(toFieldError) : [],
        cause: exception,
        traceId: currentRequestId(),
      },
    };
  }

  /**
   * El fallo saneado que reciben los puertos, y lo que decidió el catálogo.
   *
   * La regla que ningún puerto puede tocar: por encima de 500 el error no trae ni
   * su código, ni su mensaje, ni sus campos, ni el proveedor, ni la causa. El
   * catálogo pone el código y el mensaje genérico de su status.
   */
  private failureOf(
    classified: Classified,
    request: HttpRequestLike,
  ): { readonly failure: ApiFailure; readonly description: ErrorDescription } {
    const { error, status, kind } = classified;
    const expected = status < 500;

    const sanitized: SanitizedError = {
      kind,
      layer: error.layer,
      type: error.type,
      code: expected ? error.code : undefined,
      message: expected ? classified.ownMessage : undefined,
      fieldErrors: expected ? error.fieldErrors : [],
    };
    const description = this.describe(sanitized, status);

    // El que el error tomó al nacer. Si nació fuera de una petición, el de la
    // que se está contestando, que el middleware también deja en `req.id`. Si
    // ni ése existe -el error ocurrió antes de que el middleware abriera el
    // contexto, como un cuerpo JSON que no se puede leer-, uno nuevo: sin él el
    // cliente no tiene nada que citar, y el log lleva el mismo valor que el
    // cuerpo.
    const traceId =
      error.traceId ?? currentRequestId() ?? request.id ?? randomUUID();

    // Una entrada por campo, para que el formulario sepa qué input marcar. Sin
    // campos, una sola con lo que decidió el catálogo.
    const errors: ApiFailureItem[] =
      sanitized.fieldErrors.length > 0
        ? sanitized.fieldErrors.map((fieldError) => ({
            code: fieldError.code ?? description.code,
            message: fieldError.message,
            field: fieldError.field,
          }))
        : [
            {
              code: description.code,
              message: description.message,
              field: null,
            },
          ];

    return {
      description,
      failure: {
        status,
        kind,
        layer: error.layer,
        traceId,
        retryAfter: error.retryAfter,
        errors,
      },
    };
  }

  /**
   * Qué código y qué mensaje lleva el fallo. Manda, en este orden, el catálogo
   * que el servicio declaró, el del estándar activo y el de Nova.
   *
   * `internalErrorMessage` es el mensaje de todo 5xx de quien no declaró un
   * catálogo propio: uno propio decide sus mensajes y no lo lee.
   */
  private describe(
    sanitized: SanitizedError,
    status: number,
  ): ErrorDescription {
    const declared: ErrorCatalog | undefined = this.ports.catalog;
    const catalog = declared ?? this.standard.errorCatalog ?? NOVA_CATALOG;
    const description = catalog.describe(sanitized, status);

    return declared === undefined &&
      status >= 500 &&
      this.options.internalErrorMessage !== undefined
      ? { ...description, message: this.options.internalErrorMessage }
      : description;
  }

  /**
   * El cuerpo y las cabeceras. El serializador que el servicio declaró contesta
   * los errores; si no, el estándar activo.
   */
  private wireOf(failure: ApiFailure): ApiWire {
    return this.ports.serializer === undefined
      ? this.standard.failure(failure)
      : this.ports.serializer.serialize(failure);
  }

  private log(
    exception: unknown,
    classified: Classified,
    failure: ApiFailure,
    description: ErrorDescription,
    request: HttpRequestLike,
  ): void {
    const { error } = classified;
    const fromException = logFieldsOf(exception);

    // Los nombres de estos campos son un contrato con el índice de logs, no una
    // preferencia: `traceId` y `statusCode` son por los que están escritas las
    // consultas y los tableros que ya existen. Nombrarlos `requestId` y `status`
    // deja las líneas de error dentro del índice y fuera de toda búsqueda, que
    // es peor que no loguearlas -- se ven en un `docker logs` y no aparecen
    // cuando alguien investiga un incidente.
    //
    // `traceId` es además el mismo valor que pino-http publica como `req.id` en
    // la línea de la petición, así que una búsqueda por el UUID trae las dos.
    //
    // Además, la capa, el tipo y el código (ADR-031) como campos y no dentro del
    // mensaje: `layer` es lo que deja alertar sobre `infrastructure` sin que un
    // 404 de negocio ensucie la señal.
    //
    // El proveedor va siempre en el objeto `upstream` (ADR-035), tanto el que
    // clasificó el cliente HTTP como el que nombró un servicio al lanzar un
    // `InfrastructureError`: un campo con dos formas rechaza líneas enteras en
    // el índice.
    //
    // Los campos propios de la excepción van primero, para que ninguno pise a
    // los de abajo: son el contrato con el índice y no se negocian.
    const detail = {
      ...fromException,
      ...(fromException['upstream'] === undefined &&
      error.upstream !== undefined
        ? { upstream: { upstream: error.upstream } }
        : {}),
      statusCode: failure.status,
      traceId: failure.traceId,
      layer: error.layer,
      type: error.type,
      code: description.code,
      method: request.method,
      path: request.url,
      errors: failure.errors.map((item) =>
        errorItem(item.code ?? description.code, item.message, item.field),
      ),
    };

    const message = logMessageOf(exception);

    // El nivel lo decide la capa y no el status (ADR-031): `domain` y
    // `application` son esperados y van en `warn`, sin el error; `infrastructure`
    // y `platform` son incidentes y van en `error`, con la causa completa. Con
    // los puertos de Nova da lo mismo que mirar si el status es 5xx, pero un
    // `ErrorStatusMapper` propio puede mover un tipo a otro status, y la señal
    // que alimenta la alerta no tiene que moverse con él. Registrar lo esperado
    // como `error` es lo que entierra los incidentes que importan.
    //
    // Sólo el incidente lleva el error con su stack: en un rechazo esperado el
    // stack apunta al código que rechazó la petición, que funcionó bien.
    if (isIncident(error.layer)) {
      this.logger.error({ ...detail, err: exception }, message);
      return;
    }

    this.logger.warn(detail, message);
  }
}
