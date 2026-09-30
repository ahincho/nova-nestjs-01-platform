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
import { errorItem } from '../../api-standard';
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
} from '../../errors';
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

  function lastError(): { detail: LogDetail; stack: unknown } {
    const [detail, stack] = errorLog.mock.lastCall ?? [];
    return { detail: detail as LogDetail, stack };
  }

  function withPorts(ports: Partial<ErrorPorts>): AllExceptionsFilter {
    return new AllExceptionsFilter(DEFAULT_API_STANDARD_OPTIONS, {
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
        errors: [{ code: 'BAD_GATEWAY', message: 'Internal server error' }],
      });
      expect(JSON.stringify(captured.body)).not.toContain('ACADEMIC');
    });

    it('keeps the field-level entries of a ValidationException', () => {
      const errors = [
        errorItem('VALIDATION_ERROR', 'must be an integer', 'periodId'),
      ];

      filter.catch(new ValidationException(errors), hostDouble(captured));

      expect(captured.status).toBe(400);
      expect(captured.body).toMatchObject({ errors });
    });

    // Un sobre de error sin entradas no le dice nada a quien lo lee.
    it('never answers a failure without entries', () => {
      filter.catch(new ValidationException([]), hostDouble(captured));

      expect(captured.body).toMatchObject({
        errors: [{ code: 'BAD_REQUEST', message: 'Validation failed' }],
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

    it('falls back to the message of an exception built with an object', () => {
      filter.catch(
        new HttpException({ reason: 'teapot' }, 418),
        hostDouble(captured),
      );

      expect(captured.body).toMatchObject({
        status: 418,
        errors: [{ code: 'REQUEST_ERROR', message: 'Http Exception' }],
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
            message: 'Internal server error',
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

    // Los 502 y 504 los lanza el cliente HTTP cuando un upstream falla. Leerlos
    // como `application` los sacaría de la alerta sobre `infrastructure`.
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
        errors: [{ code: 'INTERNAL_SERVER_ERROR' }],
      });
      expect(lastError().detail).toMatchObject({
        layer: Layer.PLATFORM,
        type: PlatformErrorType.INTERNAL,
      });
    });
  });

  describe('an UpstreamHttpError nobody translated', () => {
    it('is infrastructure, and a 502', () => {
      const body = catchInRequest(
        () => new UpstreamHttpError(500, { detail: 'academic-db refused' }, {}),
      );

      expect(captured.status).toBe(502);
      expect(body.errors).toEqual([
        {
          code: 'BAD_GATEWAY',
          message: 'Internal server error',
          field: null,
        },
      ]);
      expect(JSON.stringify(body)).not.toContain('academic-db');
      expect(lastError().detail).toMatchObject({
        layer: Layer.INFRASTRUCTURE,
        type: InfrastructureErrorType.BAD_GATEWAY,
      });
    });

    // La misma lectura que hace el cliente cuando no se le pide el error crudo.
    it.each([504, 408])(
      'is a timeout when the upstream answered %i',
      (code) => {
        catchInRequest(() => new UpstreamHttpError(code, null, {}));

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
      filter.catch(
        new Error('connect ECONNREFUSED 10.0.3.14:5432'),
        hostDouble(captured),
      );

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body).toEqual({
        success: false,
        status: 500,
        data: null,
        errors: [
          {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Internal server error',
            field: null,
          },
        ],
        metadata: { traceId: 'req-1' },
      });
      expect(JSON.stringify(captured.body)).not.toContain('ECONNREFUSED');
      expect(lastError().detail).toMatchObject({
        layer: Layer.PLATFORM,
        type: PlatformErrorType.INTERNAL,
        message: 'connect ECONNREFUSED 10.0.3.14:5432',
      });
    });

    it('answers a thrown value that is not an Error', () => {
      filter.catch('boom', hostDouble(captured));

      expect(captured.status).toBe(500);
      expect(lastError().stack).toBeUndefined();
    });

    it('reports the configured internal message', () => {
      const custom = new AllExceptionsFilter({
        ...DEFAULT_API_STANDARD_OPTIONS,
        internalErrorMessage: 'Error interno del servidor',
      });

      custom.catch(new Error('boom'), hostDouble(captured));

      expect(captured.body).toMatchObject({
        errors: [
          expect.objectContaining({ message: 'Error interno del servidor' }),
        ],
      });
    });
  });

  // Los casos de ADR-031 que los tres stacks tienen que contestar igual.
  describe('the ADR-031 contract suite', () => {
    const ownCatalog: ErrorCatalog = {
      describe: (error, status) => ({
        code: `ORG_${status}`,
        message: `org: ${error.message}`,
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
          expect(body.errors[0]?.message).toBe('Internal server error'),
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
        upstream: 'academic-orchestrator',
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

    it('is null, never absent, when nothing knows it', () => {
      filter.catch(DomainError.notFound('x'), hostDouble(captured, 'http', {}));

      expect((captured.body as Envelope).metadata).toEqual({ traceId: null });
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

    // Un error esperado va sin stack, que es lo que hace ruido en el índice.
    it('logs an expected error as fields and without a stack', () => {
      catchInRequest(() =>
        DomainError.notFound('Pedido no encontrado', {
          code: 'ORDER_NOT_FOUND',
        }),
      );

      expect(warnLog.mock.lastCall).toHaveLength(1);
      expect(lastWarn()).toMatchObject({
        traceId: TRACE_ID,
        layer: Layer.DOMAIN,
        type: DomainErrorType.NOT_FOUND,
        code: 'ORDER_NOT_FOUND',
        status: 404,
        message: 'Pedido no encontrado',
        requestId: 'req-1',
        method: 'GET',
        path: '/v1/students/7',
      });
    });

    it('logs the field errors of an invalid input', () => {
      catchInRequest(() =>
        ApplicationError.invalidInput('x', [
          { field: 'periodId', message: 'Debe ser un entero' },
        ]),
      );

      expect(lastWarn()['fieldErrors']).toEqual([
        { field: 'periodId', message: 'Debe ser un entero' },
      ]);
    });

    // Un incidente va con la causa entera, encadenada como en Java.
    it('logs an incident with its cause', () => {
      const cause = new Error('socket hang up');

      catchInRequest(() =>
        InfrastructureError.badGateway('payments', { cause }),
      );

      const { detail, stack } = lastError();
      expect(detail).toMatchObject({
        layer: Layer.INFRASTRUCTURE,
        code: 'BAD_GATEWAY',
        upstream: 'payments',
      });
      expect(stack).toContain(
        'Upstream payments answered with an invalid response',
      );
      expect(stack).toContain('Caused by: Error: socket hang up');
    });

    it('stops following causes after five', () => {
      let chain = new Error('cause 0');
      for (let depth = 1; depth <= 8; depth += 1) {
        chain = new Error(`cause ${depth}`, { cause: chain });
      }

      catchInRequest(() => chain);

      expect(String(lastError().stack).match(/Caused by:/g)).toHaveLength(5);
    });

    it('reports instead of answering when there is no HTTP context', () => {
      filter.catch(new Error('boom'), hostDouble(captured, 'rpc'));

      expect(captured.status).toBeUndefined();
      expect(errorLog).toHaveBeenCalledTimes(1);
    });
  });

  describe('the ports', () => {
    it('asks the status mapper for the status of a Nova error', () => {
      const statusMapper = { statusOf: vi.fn(() => 418) };
      filter = withPorts({ statusMapper });
      const error = DomainError.notFound('x');

      filter.catch(error, hostDouble(captured));

      expect(statusMapper.statusOf).toHaveBeenCalledWith(error);
      expect(captured.status).toBe(418);
    });

    // Un framework ya dice su status, y se respeta: así un servicio migra de a
    // poco sin que lo que no cambió conteste distinto.
    it('keeps the status of a framework exception without asking', () => {
      const statusMapper = new NovaErrorStatusMapper();
      const statusOf = vi.spyOn(statusMapper, 'statusOf');
      filter = withPorts({ statusMapper });

      filter.catch(new NotFoundException(), hostDouble(captured));

      expect(statusOf).not.toHaveBeenCalled();
      expect(captured.status).toBe(404);
    });

    it('answers with the body and headers of the serializer', () => {
      const serializer: ErrorSerializer = {
        serialize: (error, reply) => ({
          headers: { 'Content-Language': 'es' },
          body: {
            type: error.layer,
            title: reply.message,
            trace: reply.traceId,
          },
        }),
      };
      filter = withPorts({ serializer });

      catchInRequest(() => DomainError.notFound('Pedido no encontrado'));

      expect(captured.body).toEqual({
        type: 'domain',
        title: 'Pedido no encontrado',
        trace: TRACE_ID,
      });
      expect(captured.headers).toEqual({ 'Content-Language': 'es' });
    });
  });
});
