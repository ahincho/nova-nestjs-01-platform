import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  MethodNotAllowedException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import {
  NovaEnvelopeStandard,
  type ApiFailure,
  type ApiStandard,
  type ApiWire,
} from '../../api-standard';
import {
  ApplicationError,
  ApplicationErrorType,
  DomainError,
  DomainErrorType,
  InfrastructureError,
  InfrastructureErrorType,
  Layer,
  NovaErrorStatusMapper,
  PlatformError,
  PlatformErrorType,
  type ErrorCatalog,
  type ErrorPorts,
  type ErrorSerializer,
  type NovaError,
  type SanitizedError,
} from '../../errors';
import {
  UpstreamException,
  type UpstreamFailure,
} from '../../http/upstream-failure';
import { UpstreamHttpError } from '../../http/upstream-http.error';
import { requestContextStorage } from '../../observability/request-context.storage';
import { ValidationException } from '../exceptions/validation.exception';
import { DEFAULT_API_STANDARD_OPTIONS, resolveErrorPorts } from '../tokens';
import { AllExceptionsFilter } from './all-exceptions.filter';
import type { MockInstance } from 'vitest';

type Captured = {
  status: number | undefined;
  body: unknown;
  headers: Record<string, string>;
};

type Envelope = {
  success: boolean;
  status: number;
  data: unknown;
  errors: { code: string; message: string; field: string | null }[];
  metadata?: { traceId: string | null };
};

type LogDetail = Record<string, unknown>;

const TRACE_ID = 'trace-1';

/**
 * Un estándar que anota lo que recibe, para poder mirar qué le entrega el
 * filtro: es la única forma de probar que el núcleo sanea antes y no después.
 */
class RecordingStandard implements ApiStandard {
  readonly received: ApiFailure[] = [];

  readonly openapi = new NovaEnvelopeStandard().openapi;

  errorCatalog?: ErrorCatalog;

  success(payload: unknown): ApiWire {
    return { body: payload };
  }

  failure(failure: ApiFailure): ApiWire {
    this.received.push(failure);
    return {
      contentType: 'application/problem+json',
      body: { title: 'problem', status: failure.status },
    };
  }

  owns(): boolean {
    return false;
  }
}

function hostDouble(
  captured: Captured,
  type: 'http' | 'rpc' = 'http',
  request: Record<string, unknown> = {
    id: 'req-1',
    url: '/v1/students/7',
    method: 'GET',
  },
): ArgumentsHost {
  const response = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(code: number) {
      captured.status = code;
      return {
        json(body: unknown) {
          captured.body = body;
          return body;
        },
      };
    },
  };

  return {
    getType: () => type,
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
}

/** Corre `callback` dentro del contexto de una petición, como el middleware. */
function inRequest<T>(callback: () => T, requestId = TRACE_ID): T {
  return requestContextStorage.run({ requestId, headers: {} }, callback);
}

/** Un fallo de una llamada saliente, ya clasificado, como lo deja el cliente. */
function upstreamFailure(
  overrides: Partial<UpstreamFailure> = {},
): UpstreamFailure {
  return {
    upstream: 'academic.internal',
    category: 'timeout',
    type: 'http_response_timeout',
    phase: 'response',
    elapsedMs: 3000,
    status: 504,
    ...overrides,
  };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let captured: Captured;
  let errorLog: MockInstance;
  let warnLog: MockInstance;

  /** Construye y atrapa el error en la misma petición, como en un servicio. */
  function catchInRequest(exception: () => unknown): Envelope {
    inRequest(() => filter.catch(exception(), hostDouble(captured)));
    return captured.body as Envelope;
  }

  function lastWarn(): LogDetail {
    return warnLog.mock.lastCall?.[0] as LogDetail;
  }

  function lastError(): { detail: LogDetail; message: unknown } {
    const [detail, message] = errorLog.mock.lastCall ?? [];
    return { detail: detail as LogDetail, message };
  }

  function withPorts(
    ports: Partial<ErrorPorts>,
    standard: ApiStandard = new NovaEnvelopeStandard(),
    options = DEFAULT_API_STANDARD_OPTIONS,
  ): AllExceptionsFilter {
    return new AllExceptionsFilter(options, standard, {
      ...resolveErrorPorts(),
      ...ports,
    });
  }

  beforeEach(() => {
    filter = new AllExceptionsFilter(DEFAULT_API_STANDARD_OPTIONS);
    captured = { status: undefined, body: undefined, headers: {} };
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    warnLog = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('an exception of the framework', () => {
    it('answers a 404 with the envelope and the derived code', () => {
      filter.catch(
        new NotFoundException('Student not found'),
        hostDouble(captured),
      );

      expect(captured.status).toBe(404);
      expect(captured.body).toEqual({
        success: false,
        status: 404,
        data: null,
        errors: [
          { code: 'NOT_FOUND', message: 'Student not found', field: null },
        ],
        metadata: { traceId: 'req-1' },
      });
    });

    // El codigo del envelope sale del status salvo que la excepcion traiga uno,
    // que es lo que NestJS 12 agrego para no tener que escribir una excepcion
    // propia por cada codigo de dominio.
    it('prefers the errorCode of the exception over the one from the status', () => {
      filter.catch(
        new NotFoundException('Course not found', {
          errorCode: 'COURSE_NOT_FOUND',
        }),
        hostDouble(captured),
      );

      expect(captured.status).toBe(404);
      expect(captured.body).toMatchObject({
        errors: [
          {
            code: 'COURSE_NOT_FOUND',
            message: 'Course not found',
            field: null,
          },
        ],
      });
    });

    // Un 5xx contesta el mensaje generico a proposito, y dejar pasar un codigo
    // de dominio ahi cuenta que fallo por dentro.
    it('ignores the errorCode of a 5xx', () => {
      filter.catch(
        new HttpException('Upstream exploded', HttpStatus.BAD_GATEWAY, {
          errorCode: 'ACADEMIC_UPSTREAM_DOWN',
        }),
        hostDouble(captured),
      );

      expect(captured.status).toBe(502);
      expect(captured.body).toMatchObject({
        errors: [
          {
            code: 'BAD_GATEWAY',
            message: 'Una dependencia respondió con un error',
          },
        ],
      });
      expect(JSON.stringify(captured.body)).not.toContain('ACADEMIC');
      expect(JSON.stringify(captured.body)).not.toContain('exploded');
    });

    // La entrada pasa por el mismo camino: una violación no trae código, y el
    // catálogo le pone el de la validación.
    it('names the violations of a ValidationException, one entry per field', () => {
      filter.catch(
        new ValidationException([
          { field: 'periodId', message: 'must be an integer' },
          { field: 'address.zipCode', message: 'must not be empty' },
        ]),
        hostDouble(captured),
      );

      expect(captured.status).toBe(400);
      expect(captured.body).toMatchObject({
        errors: [
          {
            code: 'VALIDATION_ERROR',
            message: 'must be an integer',
            field: 'periodId',
          },
          {
            code: 'VALIDATION_ERROR',
            message: 'must not be empty',
            field: 'address.zipCode',
          },
        ],
      });
    });

    it('keeps the code a violation brings, and a violation with no field', () => {
      filter.catch(
        new ValidationException([
          { field: null, message: 'the range is empty', code: 'EMPTY_RANGE' },
        ]),
        hostDouble(captured),
      );

      expect(captured.body).toMatchObject({
        errors: [
          { code: 'EMPTY_RANGE', message: 'the range is empty', field: null },
        ],
      });
    });

    // Un sobre de error sin entradas no le dice nada a quien lo lee.
    it('never answers a failure without entries', () => {
      filter.catch(new ValidationException([]), hostDouble(captured));

      expect(captured.body).toMatchObject({
        errors: [
          {
            code: 'VALIDATION_ERROR',
            message: 'La solicitud no es válida',
            field: null,
          },
        ],
      });
    });

    it('joins the array of messages NestJS builds for a 400', () => {
      filter.catch(
        new BadRequestException(['first problem', 'second problem']),
        hostDouble(captured),
      );

      expect(captured.body).toMatchObject({
        errors: [
          {
            code: 'BAD_REQUEST',
            message: 'first problem, second problem',
            field: null,
          },
        ],
      });
    });

    // Un 4xx sin mensaje propio lleva el de su código (ADR-031). Los que trae
    // NestJS -`Not Found`, `Forbidden`- son del framework, en inglés.
    it.each([
      [new BadRequestException(), 'La solicitud no es válida'],
      [new UnauthorizedException(), 'Hace falta autenticarse'],
      [new ForbiddenException(), 'No hay permiso para esta operación'],
      [new NotFoundException(), 'El recurso no existe'],
      [
        new MethodNotAllowedException(),
        'El método no está permitido en este recurso',
      ],
      [
        new ConflictException(),
        'La operación choca con el estado actual del recurso',
      ],
    ])('answers %s with the message of its status', (exception, message) => {
      filter.catch(exception, hostDouble(captured));

      expect(captured.body).toMatchObject({ errors: [{ message }] });
    });

    it('answers an exception built with an object with the message of its status', () => {
      filter.catch(
        new HttpException({ reason: 'teapot' }, 418),
        hostDouble(captured),
      );

      expect(captured.body).toMatchObject({
        status: 418,
        errors: [
          { code: 'REQUEST_ERROR', message: 'La solicitud no se pudo atender' },
        ],
      });
    });

    // Same rule for a 5xx raised deliberately: the message names the upstream.
    it('answers an explicit 502 with the generic message', () => {
      filter.catch(
        new HttpException('Upstream schedules service is down', 502),
        hostDouble(captured),
      );

      expect(captured.body).toMatchObject({
        status: 502,
        errors: [
          {
            code: 'BAD_GATEWAY',
            message: 'Una dependencia respondió con un error',
            field: null,
          },
        ],
      });
      expect(JSON.stringify(captured.body)).not.toContain('schedules');
    });

    // ADR-031: las excepciones del framework se leen por su status. Lo que
    // cambia es la capa y el tipo en el log; el status y el cuerpo, no.
    it.each([
      [
        new BadRequestException('x'),
        Layer.APPLICATION,
        ApplicationErrorType.INVALID_INPUT,
      ],
      [
        new UnauthorizedException(),
        Layer.APPLICATION,
        ApplicationErrorType.UNAUTHENTICATED,
      ],
      [
        new ForbiddenException(),
        Layer.APPLICATION,
        ApplicationErrorType.FORBIDDEN,
      ],
      [
        new ConflictException('x'),
        Layer.APPLICATION,
        ApplicationErrorType.CONFLICT,
      ],
      [
        new HttpException('x', 422),
        Layer.APPLICATION,
        ApplicationErrorType.UNPROCESSABLE,
      ],
      [
        new HttpException('x', 429),
        Layer.APPLICATION,
        ApplicationErrorType.RATE_LIMITED,
      ],
      [new NotFoundException(), Layer.APPLICATION, undefined],
      [new MethodNotAllowedException(), Layer.APPLICATION, undefined],
    ])('reads %s as application by its status', (exception, layer, type) => {
      filter.catch(exception, hostDouble(captured));

      expect(captured.status).toBe(exception.getStatus());
      expect(lastWarn()).toMatchObject({ layer, type });
    });

    // Los 502, 503 y 504 los lanza el cliente HTTP cuando un upstream falla.
    // Leerlos como `application` los sacaría de la alerta sobre `infrastructure`.
    it.each([
      [new HttpException('x', 502), InfrastructureErrorType.BAD_GATEWAY],
      [new ServiceUnavailableException(), InfrastructureErrorType.UNAVAILABLE],
      [new HttpException('x', 504), InfrastructureErrorType.TIMEOUT],
    ])('reads %s as infrastructure by its status', (exception, type) => {
      filter.catch(exception, hostDouble(captured));

      expect(lastError().detail).toMatchObject({
        layer: Layer.INFRASTRUCTURE,
        type,
      });
    });

    it('reads any other 5xx as platform and keeps its status', () => {
      filter.catch(new HttpException('x', 501), hostDouble(captured));

      expect(captured.status).toBe(501);
      expect(captured.body).toMatchObject({
        errors: [
          {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Error interno del servidor',
          },
        ],
      });
      expect(lastError().detail).toMatchObject({
        layer: Layer.PLATFORM,
        type: PlatformErrorType.INTERNAL,
      });
    });
  });

  // El cliente HTTP deja todo fallo de una llamada saliente clasificado
  // (ADR-035). El filtro lo lee como un fallo de `infrastructure` con el
  // proveedor que la clasificación ya conoce, así que el campo `upstream` del
  // log se llena sin que el servicio lance nada.
  describe('an upstream failure', () => {
    const call = {
      method: 'GET',
      url: 'http://academic.internal/courses',
      timeoutMs: 3000,
    };

    it('is infrastructure, and the log names the provider the classification knows', () => {
      const failure = upstreamFailure({
        status: 502,
        category: 'connectivity',
        type: 'connection_refused',
        code: 'ECONNREFUSED',
      });

      filter.catch(
        new UpstreamException(failure, undefined, call),
        hostDouble(captured),
      );

      expect(captured.status).toBe(502);
      expect(lastError().detail).toMatchObject({
        layer: Layer.INFRASTRUCTURE,
        type: InfrastructureErrorType.BAD_GATEWAY,
        code: 'BAD_GATEWAY',
        statusCode: 502,
        upstream: {
          upstream: 'academic.internal',
          category: 'connectivity',
          type: 'connection_refused',
          code: 'ECONNREFUSED',
        },
        outbound: call,
      });
    });

    it('answers a timeout as a 504 of infrastructure', () => {
      filter.catch(
        new UpstreamException(upstreamFailure(), undefined, call),
        hostDouble(captured),
      );

      expect(captured.status).toBe(504);
      expect(captured.body).toMatchObject({
        errors: [
          {
            code: 'GATEWAY_TIMEOUT',
            message: 'Una dependencia no respondió a tiempo',
          },
        ],
      });
      expect(lastError().detail).toMatchObject({
        layer: Layer.INFRASTRUCTURE,
        type: InfrastructureErrorType.TIMEOUT,
      });
    });

    // El proveedor, la URL y el motivo van al log y nunca al cuerpo.
    it('keeps the provider, the call and the cause out of the body', () => {
      filter.catch(
        new UpstreamException(
          upstreamFailure({ status: 502, code: 'ECONNREFUSED' }),
          new Error('connect ECONNREFUSED 10.0.3.14:5432'),
          call,
        ),
        hostDouble(captured),
      );

      const body = JSON.stringify(captured.body);
      expect(body).not.toContain('academic');
      expect(body).not.toContain('10.0.3.14');
      expect(body).not.toContain('ECONNREFUSED');
    });

    // Un fallo nuestro antes de salir -una URL mal configurada- no es de la
    // dependencia: es de `platform`, aunque la clasificación siga en el log.
    it('is platform when the failure was ours before leaving', () => {
      filter.catch(
        new UpstreamException(
          upstreamFailure({
            status: 500,
            category: 'internal',
            type: 'proxy_configuration_error',
          }),
        ),
        hostDouble(captured),
      );

      expect(captured.status).toBe(500);
      expect(captured.body).toMatchObject({
        errors: [{ code: 'INTERNAL_SERVER_ERROR' }],
      });
      expect(lastError().detail).toMatchObject({
        layer: Layer.PLATFORM,
        type: PlatformErrorType.INTERNAL,
        upstream: { category: 'internal' },
      });
    });

    // Lo que el llamador relanza de `forwardError` es un fallo del upstream, y
    // sale como 502 o 504 y no como un 500 propio.
    it('reads what a caller rethrows from forwardError as the upstream failing', () => {
      filter.catch(
        new UpstreamHttpError(500, { detail: 'academic-db refused' }, {}),
        hostDouble(captured),
      );

      expect(captured.status).toBe(502);
      expect(JSON.stringify(captured.body)).not.toContain('academic-db');
      expect(lastError().detail).toMatchObject({
        layer: Layer.INFRASTRUCTURE,
        type: InfrastructureErrorType.BAD_GATEWAY,
      });
    });

    it.each([504, 408])(
      'reads a rethrown %i from the upstream as a timeout',
      (code) => {
        filter.catch(
          new UpstreamHttpError(code, null, {}),
          hostDouble(captured),
        );

        expect(captured.status).toBe(504);
        expect(captured.body).toMatchObject({
          errors: [{ code: 'GATEWAY_TIMEOUT' }],
        });
      },
    );
  });

  describe('anything else', () => {
    // The message of the original failure names tables, hosts and libraries. It
    // belongs in the log, never in the body.
    it('never leaks the message of an unknown failure', () => {
      const boom = new Error('connect ECONNREFUSED 10.0.3.14:5432');

      filter.catch(boom, hostDouble(captured));

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body).toEqual({
        success: false,
        status: 500,
        data: null,
        errors: [
          {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Error interno del servidor',
            field: null,
          },
        ],
        metadata: { traceId: 'req-1' },
      });
      expect(JSON.stringify(captured.body)).not.toContain('ECONNREFUSED');
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          layer: Layer.PLATFORM,
          type: PlatformErrorType.INTERNAL,
          err: boom,
        }),
        'connect ECONNREFUSED 10.0.3.14:5432',
      );
    });

    it('answers a thrown value that is not an Error', () => {
      filter.catch('boom', hostDouble(captured));

      expect(captured.status).toBe(500);
    });

    // La opción de siempre sigue siendo el mensaje de todo 5xx de quien no
    // declara un catálogo propio.
    it('reports the configured internal message', () => {
      const custom = new AllExceptionsFilter({
        ...DEFAULT_API_STANDARD_OPTIONS,
        internalErrorMessage: 'Error interno del servicio',
      });

      custom.catch(new Error('boom'), hostDouble(captured));
      expect(captured.body).toMatchObject({
        errors: [
          expect.objectContaining({ message: 'Error interno del servicio' }),
        ],
      });

      custom.catch(new HttpException('x', 504), hostDouble(captured));
      expect(captured.body).toMatchObject({
        errors: [
          expect.objectContaining({
            code: 'GATEWAY_TIMEOUT',
            message: 'Error interno del servicio',
          }),
        ],
      });
    });
  });

  // Los casos de ADR-031 que los tres stacks tienen que contestar igual.
  describe('the ADR-031 contract suite', () => {
    const ownCatalog: ErrorCatalog = {
      describe: (error, status) => ({
        code: `ORG_${status}`,
        message: `org: ${error.message ?? 'sin mensaje'}`,
      }),
    };

    it.each<{
      name: string;
      exception: () => unknown;
      status: number;
      code: string;
      ports?: Partial<ErrorPorts>;
      check?: (body: Envelope, headers: Record<string, string>) => void;
    }>([
      {
        name: 'DomainError.notFound with its own code',
        exception: () =>
          DomainError.notFound('Pedido no encontrado', {
            code: 'ORDER_NOT_FOUND',
          }),
        status: 404,
        code: 'ORDER_NOT_FOUND',
        check: (body) =>
          expect(body.errors[0]?.message).toBe('Pedido no encontrado'),
      },
      {
        name: 'DomainError.conflict without a code',
        exception: () => DomainError.conflict('El pedido ya fue cancelado'),
        status: 409,
        code: 'CONFLICT',
      },
      {
        name: 'ApplicationError.invalidInput with two fields',
        exception: () =>
          ApplicationError.invalidInput('La entrada no es válida', [
            { field: 'periodId', message: 'Debe ser un entero' },
            { field: 'studentId', message: 'No puede estar vacío' },
          ]),
        status: 400,
        code: 'BAD_REQUEST',
        check: (body) =>
          expect(body.errors).toEqual([
            {
              code: 'BAD_REQUEST',
              message: 'Debe ser un entero',
              field: 'periodId',
            },
            {
              code: 'BAD_REQUEST',
              message: 'No puede estar vacío',
              field: 'studentId',
            },
          ]),
      },
      {
        name: 'ApplicationError.conflict with a retryAfter of 1 s',
        exception: () =>
          ApplicationError.conflict('La operación sigue en curso', {
            retryAfter: 1,
          }),
        status: 409,
        code: 'CONFLICT',
        check: (_body, headers) => expect(headers['Retry-After']).toBe('1'),
      },
      {
        name: 'ApplicationError.rateLimited with 30 s',
        exception: () =>
          ApplicationError.rateLimited('Demasiadas solicitudes', {
            retryAfter: 30,
          }),
        status: 429,
        code: 'TOO_MANY_REQUESTS',
        check: (_body, headers) => expect(headers['Retry-After']).toBe('30'),
      },
      {
        name: 'InfrastructureError.timeout of an upstream',
        exception: () => InfrastructureError.timeout('academic-orchestrator'),
        status: 504,
        code: 'GATEWAY_TIMEOUT',
        check: (body) =>
          expect(JSON.stringify(body)).not.toContain('academic-orchestrator'),
      },
      {
        name: 'InfrastructureError.unavailable',
        exception: () => InfrastructureError.unavailable('payments'),
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      },
      {
        name: 'any exception',
        exception: () => new TypeError('Cannot read properties of undefined'),
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        check: (body) =>
          expect(body.errors[0]?.message).toBe('Error interno del servidor'),
      },
      {
        name: 'a catalog of its own registered by the service',
        exception: () => DomainError.notFound('Pedido no encontrado'),
        ports: { catalog: ownCatalog },
        status: 404,
        code: 'ORG_404',
        check: (body) =>
          expect(body.errors[0]?.message).toBe('org: Pedido no encontrado'),
      },
    ])('$name', ({ exception, status, code, ports, check }) => {
      filter = withPorts(ports ?? {});

      const body = catchInRequest(exception);

      expect(captured.status).toBe(status);
      expect(body.success).toBe(false);
      expect(body.status).toBe(status);
      expect(body.data).toBeNull();
      expect(body.errors[0]?.code).toBe(code);
      expect(body.metadata?.traceId).toBe(TRACE_ID);
      check?.(body, captured.headers);
    });

    // La otra mitad del caso del proveedor: el cuerpo no lo nombra, el log sí.
    it('names the upstream of a timeout in the log', () => {
      catchInRequest(() =>
        InfrastructureError.timeout('academic-orchestrator'),
      );

      expect(lastError().detail).toMatchObject({
        traceId: TRACE_ID,
        layer: Layer.INFRASTRUCTURE,
        code: 'GATEWAY_TIMEOUT',
        upstream: { upstream: 'academic-orchestrator' },
      });
    });
  });

  // Cada fila de la tabla de ADR-031, de punta a punta: la capa y el tipo que
  // se lanzan, y el status y el código que ve el cliente.
  describe('every row of the ADR-031 table', () => {
    it.each<[() => NovaError, number, string]>([
      [() => DomainError.notFound('x'), 404, 'NOT_FOUND'],
      [() => DomainError.conflict('x'), 409, 'CONFLICT'],
      [() => DomainError.ruleViolation('x'), 422, 'UNPROCESSABLE_ENTITY'],
      [() => ApplicationError.invalidInput('x'), 400, 'BAD_REQUEST'],
      [() => ApplicationError.conflict('x'), 409, 'CONFLICT'],
      [() => ApplicationError.unprocessable('x'), 422, 'UNPROCESSABLE_ENTITY'],
      [() => ApplicationError.unauthenticated('x'), 401, 'UNAUTHORIZED'],
      [() => ApplicationError.forbidden('x'), 403, 'FORBIDDEN'],
      [() => ApplicationError.rateLimited('x'), 429, 'TOO_MANY_REQUESTS'],
      [() => InfrastructureError.unavailable('u'), 503, 'SERVICE_UNAVAILABLE'],
      [() => InfrastructureError.timeout('u'), 504, 'GATEWAY_TIMEOUT'],
      [() => InfrastructureError.badGateway('u'), 502, 'BAD_GATEWAY'],
      [() => PlatformError.internal('x'), 500, 'INTERNAL_SERVER_ERROR'],
    ])('answers row %# with %i %s', (error, status, code) => {
      const body = catchInRequest(error);

      expect(captured.status).toBe(status);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]?.code).toBe(code);
    });
  });

  describe('the traceId', () => {
    // Se toma al nacer y no al responder: si el error viajó a otra petición, o
    // el contexto se perdió en el camino, cita la petición donde ocurrió.
    it('is the one the error captured when it was built', () => {
      const error = inRequest(() => DomainError.notFound('x'), 'born-here');

      const body = catchInRequest(() => error);

      expect(body.metadata?.traceId).toBe('born-here');
      expect(lastWarn()).toMatchObject({ traceId: 'born-here' });
    });

    it('falls back to the request being answered', () => {
      const error = DomainError.notFound('built outside any request');

      const body = catchInRequest(() => error);

      expect(body.metadata?.traceId).toBe(TRACE_ID);
    });

    // Sin contexto -la aplicación no montó el middleware- queda el `req.id`.
    it('falls back to the id of the request object', () => {
      filter.catch(DomainError.notFound('x'), hostDouble(captured));

      expect((captured.body as Envelope).metadata?.traceId).toBe('req-1');
    });

    // Un cuerpo JSON que no se puede leer falla antes de que el middleware abra
    // el contexto: ni el error ni la petición traen id. El cliente no se va sin
    // algo que citar, y el log lleva el mismo valor que el cuerpo.
    it('is minted, and logged, when nothing knows it', () => {
      filter.catch(DomainError.notFound('x'), hostDouble(captured, 'http', {}));

      const { metadata } = captured.body as Envelope;

      expect(metadata?.traceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      );
      expect(lastWarn()['traceId']).toBe(metadata?.traceId);
    });

    it('goes into the log line with the same value as the body', () => {
      const body = catchInRequest(() => new Error('boom'));

      expect(lastError().detail['traceId']).toBe(body.metadata?.traceId);
    });
  });

  describe('logging', () => {
    // A 4xx logged at error level is what buries the 5xx that need attention.
    it('logs a 4xx as a warning and a 5xx as an error', () => {
      filter.catch(
        new ConflictException('Already enrolled'),
        hostDouble(captured),
      );
      expect(warnLog).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalled();

      filter.catch(new Error('boom'), hostDouble(captured));
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    // El nivel lo decide la capa y no el status: un `ErrorStatusMapper` propio
    // puede mover un tipo a otro status sin mover la señal de los incidentes.
    it('logs an expected error as a warning even if its status is a 5xx', () => {
      filter = withPorts({ statusMapper: { statusOf: () => 503 } });

      catchInRequest(() => DomainError.notFound('x'));

      expect(captured.status).toBe(503);
      expect(warnLog).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalled();
      expect(lastWarn()).not.toHaveProperty('err');
    });

    it('logs an incident as an error even if its status is a 4xx', () => {
      filter = withPorts({ statusMapper: { statusOf: () => 408 } });
      const timeout = InfrastructureError.timeout('payments');

      catchInRequest(() => timeout);

      expect(captured.status).toBe(408);
      expect(warnLog).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(lastError().detail['err']).toBe(timeout);
    });

    // Un error esperado va sin el error adentro, que es lo que hace ruido en el
    // índice.
    it('logs an expected error as fields and without the error', () => {
      catchInRequest(() =>
        DomainError.notFound('Pedido no encontrado', {
          code: 'ORDER_NOT_FOUND',
        }),
      );

      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: TRACE_ID,
          layer: Layer.DOMAIN,
          type: DomainErrorType.NOT_FOUND,
          code: 'ORDER_NOT_FOUND',
          statusCode: 404,
          method: 'GET',
          path: '/v1/students/7',
        }),
        'Pedido no encontrado',
      );
      expect(lastWarn()).not.toHaveProperty('err');
    });

    it('logs the field entries of an invalid input', () => {
      catchInRequest(() =>
        ApplicationError.invalidInput('x', [
          { field: 'periodId', message: 'Debe ser un entero' },
        ]),
      );

      expect(lastWarn()['errors']).toEqual([
        {
          code: 'BAD_REQUEST',
          message: 'Debe ser un entero',
          field: 'periodId',
        },
      ]);
    });

    // Un incidente va con el error entero: pino lo serializa con su stack y las
    // causas encadenadas.
    it('logs an incident with its cause', () => {
      const cause = new Error('socket hang up');
      const error = InfrastructureError.badGateway('payments', { cause });

      catchInRequest(() => error);

      const { detail, message } = lastError();
      expect(detail).toMatchObject({
        layer: Layer.INFRASTRUCTURE,
        code: 'BAD_GATEWAY',
        upstream: { upstream: 'payments' },
        err: error,
      });
      expect(message).toBe(
        'Upstream payments answered with an invalid response',
      );
      expect((detail['err'] as Error).cause).toBe(cause);
    });

    it('reports instead of answering when there is no HTTP context', () => {
      const boom = new Error('boom');

      filter.catch(boom, hostDouble(captured, 'rpc'));

      expect(captured.status).toBeUndefined();
      expect(errorLog).toHaveBeenCalledWith(
        { err: boom },
        'Unhandled exception outside an HTTP context',
      );
    });

    // Con la forma del ConsoleLogger, `error(campos, stack)`, pino toma el
    // segundo argumento como mensaje: cada línea era distinta y agrupar por
    // mensaje dejaba de servir justo para los errores.
    describe('the message and the stack of the log line', () => {
      it('keeps the stack out of the message, in err', () => {
        const boom = new Error('boom');

        filter.catch(boom, hostDouble(captured));

        expect(errorLog).toHaveBeenCalledWith(
          expect.objectContaining({ err: boom }),
          'boom',
        );
        const [, message] = errorLog.mock.calls[0] as [unknown, string];
        expect(message).not.toContain('\n');
      });

      it('logs a 4xx with its message and without a stack', () => {
        filter.catch(
          new NotFoundException('Student not found'),
          hostDouble(captured),
        );

        expect(warnLog).toHaveBeenCalledWith(
          expect.not.objectContaining({ err: expect.anything() }),
          'Student not found',
        );
      });

      it('names a thrown value that is not an Error', () => {
        filter.catch('boom', hostDouble(captured));
        filter.catch({ reason: 'boom' }, hostDouble(captured));

        expect(errorLog).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ err: 'boom' }),
          'boom',
        );
        expect(errorLog).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ err: { reason: 'boom' } }),
          'Unhandled exception',
        );
      });
    });

    // Los nombres de estos campos son un contrato con el índice de logs, no una
    // preferencia: las consultas y los tableros que ya existen están escritos
    // sobre `traceId` y `statusCode`. Llamarlos de otra forma deja las líneas
    // dentro del índice y fuera de toda búsqueda, que es peor que no loguearlas.
    //
    // `traceId` es además el mismo valor que pino-http publica como `req.id`, así
    // que una búsqueda por el UUID trae la línea de la petición y la del error.
    it('logs the fields the log index is queried by', () => {
      filter.catch(
        new ConflictException('Already enrolled'),
        hostDouble(captured),
      );

      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'req-1',
          statusCode: 409,
          method: 'GET',
          path: '/v1/students/7',
        }),
        'Already enrolled',
      );
    });

    // El proveedor va siempre en el objeto `upstream`: un campo con dos formas,
    // texto en una línea y objeto en otra, hace que el índice rechace la
    // segunda.
    it('writes the provider of a thrown InfrastructureError in the same object', () => {
      catchInRequest(() => InfrastructureError.unavailable('payments'));

      expect(lastError().detail['upstream']).toEqual({ upstream: 'payments' });
    });

    // Una excepción puede traer campos para su línea de log. El cliente HTTP los
    // usa para la clasificación del fallo de upstream, y el filtro los lee por su
    // forma, sin importar el módulo que la lanzó.
    describe('the fields an exception brings for its log', () => {
      function withLogFields(logFields: unknown): HttpException {
        return Object.assign(
          new HttpException('Upstream service error', HttpStatus.BAD_GATEWAY),
          { logFields },
        );
      }

      it('adds them to the log line', () => {
        filter.catch(
          withLogFields({ upstream: { category: 'connectivity' } }),
          hostDouble(captured),
        );

        expect(errorLog).toHaveBeenCalledWith(
          expect.objectContaining({
            upstream: { category: 'connectivity' },
            statusCode: 502,
            traceId: 'req-1',
          }),
          expect.anything(),
        );
      });

      // Los campos del índice son un contrato; ninguna excepción los pisa.
      it('never lets them overwrite the fields the index is queried by', () => {
        filter.catch(
          withLogFields({
            traceId: 'forged',
            statusCode: 200,
            layer: 'forged',
          }),
          hostDouble(captured),
        );

        expect(errorLog).toHaveBeenCalledWith(
          expect.objectContaining({
            traceId: 'req-1',
            statusCode: 502,
            layer: Layer.INFRASTRUCTURE,
          }),
          expect.anything(),
        );
      });

      it('keeps them out of the response body', () => {
        filter.catch(
          withLogFields({ upstream: { upstream: 'academic.internal' } }),
          hostDouble(captured),
        );

        expect(JSON.stringify(captured.body)).not.toContain(
          'academic.internal',
        );
      });

      it('ignores a logFields that is not an object', () => {
        filter.catch(withLogFields('not an object'), hostDouble(captured));

        expect(errorLog).toHaveBeenCalledWith(
          expect.not.objectContaining({ 0: 'n' }),
          expect.anything(),
        );
      });
    });
  });

  // La reconciliación de ADR-031 con ADR-034: ningún puerto recibe el error como
  // nació. El núcleo escribe el log con el proveedor y la causa, y a los puertos
  // les entrega un fallo ya saneado.
  describe('the ports', () => {
    // Un puerto que anota lo que recibe: es la única forma de probar qué ve.
    function recordingCatalog(): {
      readonly catalog: ErrorCatalog;
      readonly seen: { error: SanitizedError; status: number }[];
    } {
      const seen: { error: SanitizedError; status: number }[] = [];
      const catalog: ErrorCatalog = {
        describe: (error, status) => {
          seen.push({ error, status });
          return { code: 'OWN_CODE', message: 'texto propio' };
        },
      };
      return { catalog, seen };
    }

    describe('the status mapper', () => {
      it('is asked for the classification of a Nova error and nothing else', () => {
        const statusOf = vi.fn(() => 418);
        filter = withPorts({ statusMapper: { statusOf } });

        filter.catch(
          InfrastructureError.timeout('academic-orchestrator', {
            code: 'ACADEMIC_TIMEOUT',
            cause: new Error('socket hang up'),
          }),
          hostDouble(captured),
        );

        expect(captured.status).toBe(418);
        expect(statusOf).toHaveBeenCalledTimes(1);
        expect(statusOf).toHaveBeenCalledWith({
          layer: Layer.INFRASTRUCTURE,
          type: InfrastructureErrorType.TIMEOUT,
          code: 'ACADEMIC_TIMEOUT',
        });
        expect(JSON.stringify(statusOf.mock.calls)).not.toContain(
          'academic-orch',
        );
        expect(JSON.stringify(statusOf.mock.calls)).not.toContain('socket');
      });

      // Un framework ya dice su status, y se respeta: así un servicio migra de a
      // poco sin que lo que no cambió conteste distinto.
      it('is not asked for the status of a framework exception', () => {
        const statusMapper = new NovaErrorStatusMapper();
        const statusOf = vi.spyOn(statusMapper, 'statusOf');
        filter = withPorts({ statusMapper });

        filter.catch(new NotFoundException(), hostDouble(captured));

        expect(statusOf).not.toHaveBeenCalled();
        expect(captured.status).toBe(404);
      });
    });

    describe('the catalog', () => {
      // La regla que ningún catálogo puede tocar: por encima de 500 el error no
      // trae ni su código, ni su mensaje, ni sus campos, ni el proveedor.
      it('is handed a 5xx with nothing of what failed inside', () => {
        const { catalog, seen } = recordingCatalog();
        filter = withPorts({ catalog });

        catchInRequest(() =>
          InfrastructureError.timeout('academic-orchestrator', {
            code: 'ACADEMIC_TIMEOUT',
            message: 'academic-orchestrator took 5000 ms',
            cause: new Error('socket hang up'),
          }),
        );

        expect(seen).toEqual([
          {
            status: 504,
            error: {
              kind: 'internal',
              layer: Layer.INFRASTRUCTURE,
              type: InfrastructureErrorType.TIMEOUT,
              code: undefined,
              message: undefined,
              fieldErrors: [],
            },
          },
        ]);
        expect(JSON.stringify(seen)).not.toContain('academic');
        expect(JSON.stringify(seen)).not.toContain('socket');
      });

      it('is handed a 4xx with what the thrower said', () => {
        const { catalog, seen } = recordingCatalog();
        filter = withPorts({ catalog });

        catchInRequest(() =>
          ApplicationError.invalidInput(
            'La entrada no es válida',
            [{ field: 'periodId', message: 'Debe ser un entero' }],
            { code: 'BAD_FORM' },
          ),
        );

        expect(seen[0]).toEqual({
          status: 400,
          error: {
            kind: 'request',
            layer: Layer.APPLICATION,
            type: ApplicationErrorType.INVALID_INPUT,
            code: 'BAD_FORM',
            message: 'La entrada no es válida',
            fieldErrors: [{ field: 'periodId', message: 'Debe ser un entero' }],
          },
        });
      });

      it('is handed no message when a framework exception brought none', () => {
        const { catalog, seen } = recordingCatalog();
        filter = withPorts({ catalog });

        filter.catch(new ForbiddenException(), hostDouble(captured));

        expect(seen[0]?.error).toMatchObject({
          kind: 'request',
          message: undefined,
        });
      });

      // Un catálogo mal escrito que devolviera todo lo que recibe no tiene de
      // dónde sacar el proveedor: por eso la regla no depende de que esté bien
      // escrito.
      it('cannot leak what it never received', () => {
        const echoing: ErrorCatalog = {
          describe: (error) => ({
            code: 'ECHO',
            message: JSON.stringify(error),
          }),
        };
        filter = withPorts({ catalog: echoing });

        catchInRequest(() =>
          InfrastructureError.timeout('academic-orchestrator', {
            code: 'ACADEMIC_TIMEOUT',
            cause: new Error('socket hang up'),
          }),
        );

        const body = JSON.stringify(captured.body);
        expect(body).not.toContain('academic-orchestrator');
        expect(body).not.toContain('ACADEMIC_TIMEOUT');
        expect(body).not.toContain('socket');
      });

      it('wins over the catalog of the standard', () => {
        const standard = new RecordingStandard();
        standard.errorCatalog = {
          describe: () => ({ code: 'STANDARD', message: 'del estándar' }),
        };
        const { catalog } = recordingCatalog();
        filter = withPorts({ catalog }, standard);

        catchInRequest(() => DomainError.notFound('x'));

        expect(standard.received[0]?.errors[0]?.code).toBe('OWN_CODE');
      });

      it('falls back to the catalog of the standard, and then to Nova', () => {
        const standard = new RecordingStandard();
        standard.errorCatalog = {
          describe: () => ({ code: 'STANDARD', message: 'del estándar' }),
        };
        filter = withPorts({}, standard);

        catchInRequest(() => DomainError.notFound('x'));
        expect(standard.received[0]?.errors[0]).toMatchObject({
          code: 'STANDARD',
          message: 'del estándar',
        });

        filter = withPorts({}, new RecordingStandard());
        catchInRequest(() => DomainError.notFound('x'));
        expect(captured.body).toEqual({ title: 'problem', status: 404 });
      });

      it('takes the codes of a Nova envelope that declares them', () => {
        filter = withPorts(
          {},
          new NovaEnvelopeStandard({ codes: { byStatus: { 409: 'TAKEN' } } }),
        );

        const body = catchInRequest(() => DomainError.conflict('x'));

        expect(body.errors[0]?.code).toBe('TAKEN');
      });

      // `internalErrorMessage` es el mensaje de todo 5xx de quien no declaró un
      // catálogo propio; uno propio decide sus mensajes y no lo lee.
      it('is not overridden by internalErrorMessage when the service declared one', () => {
        const { catalog } = recordingCatalog();
        filter = withPorts({ catalog }, new NovaEnvelopeStandard(), {
          ...DEFAULT_API_STANDARD_OPTIONS,
          internalErrorMessage: 'Error interno del servicio',
        });

        const body = catchInRequest(() => new Error('boom'));

        expect(body.errors[0]?.message).toBe('texto propio');
      });
    });

    describe('the serializer', () => {
      it('is handed the sanitised failure, with the layer and how long to wait', () => {
        const received: ApiFailure[] = [];
        const serializer: ErrorSerializer = {
          serialize: (failure) => {
            received.push(failure);
            return { body: null };
          },
        };
        filter = withPorts({ serializer });

        catchInRequest(() =>
          ApplicationError.rateLimited('Demasiadas solicitudes', {
            retryAfter: 30,
          }),
        );

        expect(received).toEqual([
          {
            status: 429,
            kind: 'request',
            layer: Layer.APPLICATION,
            traceId: TRACE_ID,
            retryAfter: 30,
            errors: [
              {
                code: 'TOO_MANY_REQUESTS',
                message: 'Demasiadas solicitudes',
                field: null,
              },
            ],
          },
        ]);
      });

      it('is handed nothing of the provider of a 5xx', () => {
        const received: ApiFailure[] = [];
        const serializer: ErrorSerializer = {
          serialize: (failure) => {
            received.push(failure);
            return { body: null };
          },
        };
        filter = withPorts({ serializer });

        catchInRequest(() =>
          InfrastructureError.timeout('academic-orchestrator', {
            message: 'took too long',
            cause: new Error('socket hang up'),
          }),
        );

        expect(received[0]).toMatchObject({
          status: 504,
          layer: Layer.INFRASTRUCTURE,
          errors: [
            {
              code: 'GATEWAY_TIMEOUT',
              message: 'Una dependencia no respondió a tiempo',
            },
          ],
        });
        expect(JSON.stringify(received)).not.toContain('academic');
        expect(JSON.stringify(received)).not.toContain('took too long');
      });

      it('answers with the body, the headers and the content type it returns', () => {
        const serializer: ErrorSerializer = {
          serialize: (failure) => ({
            contentType: 'application/problem+json',
            headers: { 'Content-Language': 'es' },
            body: { title: failure.errors[0]?.message, trace: failure.traceId },
          }),
        };
        filter = withPorts({ serializer });

        catchInRequest(() => DomainError.notFound('Pedido no encontrado'));

        expect(captured.body).toEqual({
          title: 'Pedido no encontrado',
          trace: TRACE_ID,
        });
        expect(captured.headers).toEqual({
          'Content-Language': 'es',
          'Content-Type': 'application/problem+json',
        });
      });

      it('wins over the standard for a failure, and leaves it the successes', () => {
        const standard = new RecordingStandard();
        const serializer: ErrorSerializer = {
          serialize: () => ({ body: { own: true } }),
        };
        filter = withPorts({ serializer }, standard);

        catchInRequest(() => DomainError.notFound('x'));

        expect(captured.body).toEqual({ own: true });
        expect(standard.received).toEqual([]);
      });
    });
  });

  // Con otro estándar la respuesta cambia de forma, pero lo que el filtro le
  // entrega sigue pasando por las mismas reglas. Estas pruebas miran esa
  // entrega y no el cuerpo, porque el cuerpo ya no es de la plataforma.
  describe('with another standard', () => {
    let standard: RecordingStandard;

    beforeEach(() => {
      standard = new RecordingStandard();
      filter = new AllExceptionsFilter(DEFAULT_API_STANDARD_OPTIONS, standard);
    });

    it('answers with the body and the content type of the standard', () => {
      filter.catch(
        new NotFoundException('Student not found'),
        hostDouble(captured),
      );

      expect(captured.status).toBe(404);
      expect(captured.body).toEqual({ title: 'problem', status: 404 });
      expect(captured.headers).toEqual({
        'Content-Type': 'application/problem+json',
      });
    });

    // La regla que ningún estándar puede tocar: lo que el estándar recibe ya
    // viene saneado, así que no tiene de dónde sacar el mensaje original.
    it('hands over an unknown failure already sanitised', () => {
      filter.catch(
        new Error('connect ECONNREFUSED 10.0.3.14:5432'),
        hostDouble(captured),
      );

      expect(standard.received).toEqual([
        {
          status: 500,
          kind: 'internal',
          layer: Layer.PLATFORM,
          traceId: 'req-1',
          errors: [
            {
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Error interno del servidor',
              field: null,
            },
          ],
        },
      ]);
      expect(JSON.stringify(standard.received)).not.toContain('ECONNREFUSED');
    });

    it('drops the domain code of a 5xx before the standard sees it', () => {
      filter.catch(
        new HttpException('Upstream exploded', HttpStatus.BAD_GATEWAY, {
          errorCode: 'ACADEMIC_UPSTREAM_DOWN',
        }),
        hostDouble(captured),
      );

      expect(standard.received[0]).toMatchObject({
        status: 502,
        kind: 'internal',
        layer: Layer.INFRASTRUCTURE,
        errors: [
          {
            code: 'BAD_GATEWAY',
            message: 'Una dependencia respondió con un error',
          },
        ],
      });
      expect(JSON.stringify(standard.received)).not.toContain('exploded');
      expect(JSON.stringify(standard.received)).not.toContain('ACADEMIC');
    });

    it('passes the code of the thrower below 500', () => {
      filter.catch(
        new NotFoundException('Course not found', {
          errorCode: 'COURSE_NOT_FOUND',
        }),
        hostDouble(captured),
      );

      expect(standard.received[0]).toMatchObject({
        kind: 'request',
        layer: Layer.APPLICATION,
        errors: [{ code: 'COURSE_NOT_FOUND', message: 'Course not found' }],
      });
    });

    // Cómo se llama un fallo de validación lo decide el catálogo, no el
    // estándar: la violación llega con el código ya puesto.
    it('passes the violations of the input named by the catalog', () => {
      filter.catch(
        new ValidationException([
          { field: 'periodId', message: 'must be an integer' },
        ]),
        hostDouble(captured),
      );

      expect(standard.received[0]).toEqual({
        status: 400,
        kind: 'validation',
        layer: Layer.APPLICATION,
        traceId: 'req-1',
        errors: [
          {
            code: 'VALIDATION_ERROR',
            message: 'must be an integer',
            field: 'periodId',
          },
        ],
      });
    });

    // La línea de log es de observabilidad: cambiar la forma de la respuesta
    // no puede cambiar lo que buscan las consultas.
    it('keeps the log line in the names of the Nova catalog', () => {
      filter.catch(
        new ConflictException('Already enrolled'),
        hostDouble(captured),
      );

      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 409,
          errors: [
            { code: 'CONFLICT', message: 'Already enrolled', field: null },
          ],
        }),
        'Already enrolled',
      );
    });
  });
});
