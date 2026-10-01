import { HttpException } from '@nestjs/common';
import { stdSerializers } from 'pino';
import {
  SENSITIVE_HEADERS,
  createRequestLoggerOptions,
  serializeError,
  type RequestLoggerOptions,
} from './logger';

type ErrorObject = (
  request: unknown,
  response: unknown,
  error: unknown,
  value: Record<string, unknown>,
) => Record<string, unknown>;

type Redact = { paths: string[]; censor: string };

/**
 * Las opciones de pino, ya separadas del destino cuando lo hay: `pinoHttp` es
 * o el objeto de opciones o la tupla `[opciones, destino]`.
 */
function pinoHttp(options: RequestLoggerOptions = {}): Record<string, unknown> {
  const params = createRequestLoggerOptions(options).pinoHttp;
  return Array.isArray(params) ? params[0] : params;
}

function redact(options: RequestLoggerOptions = {}): Redact {
  return pinoHttp(options)['redact'] as Redact;
}

describe('createRequestLoggerOptions', () => {
  it('defaults to the info level', () => {
    expect(pinoHttp()['level']).toBe('info');
    expect(pinoHttp({ level: 'debug' })['level']).toBe('debug');
  });

  // A log index is read by more people than the database it protects, and a
  // token pasted into a search box is a working credential.
  it.each(SENSITIVE_HEADERS)('redacts %s in both directions', (header) => {
    const paths = redact().paths;

    expect(paths).toContain(`req.headers["${header}"]`);
    expect(paths).toContain(`res.headers["${header}"]`);
  });

  it('redacts the extra headers a service declares', () => {
    const paths = redact({ redactHeaders: ['x-student-document'] }).paths;

    expect(paths).toContain('req.headers["x-student-document"]');
    expect(paths).toContain('req.headers["authorization"]');
  });

  it('censors rather than dropping, so the header is visibly hidden', () => {
    expect(redact().censor).toBe('[redacted]');
  });

  // One id has to follow a call across services; a logger that mints its own
  // breaks the trace at every hop.
  it('takes the request id from the context when there is one', () => {
    const genReqId = pinoHttp({ requestId: () => 'req-1' })[
      'genReqId'
    ] as () => string;

    expect(genReqId()).toBe('req-1');
  });

  it('falls back to a generated id outside a request', () => {
    const genReqId = pinoHttp({ requestId: () => undefined })[
      'genReqId'
    ] as () => string;

    expect(genReqId()).toEqual(expect.any(String));
  });

  it('reads the id from the first of several headers that carries one', () => {
    const genReqId = pinoHttp({
      requestIdHeader: ['transaction-id', 'x-request-id'],
    })['genReqId'] as (request: unknown) => string;

    expect(genReqId({ headers: { 'x-request-id': 'r-1' } })).toBe('r-1');
    expect(
      genReqId({
        headers: { 'transaction-id': 'tx-1', 'x-request-id': 'r-1' },
      }),
    ).toBe('tx-1');
  });

  // Fixed messages, because the searchable part of a request log is the
  // structured fields; a message that interpolates the path makes every line
  // unique and the aggregation useless.
  it('reports one message for a completed request and one for a failed one', () => {
    const params = pinoHttp();
    const success = params['customSuccessMessage'] as () => string;
    const error = params['customErrorMessage'] as () => string;

    expect(success()).toBe('request completed');
    expect(error()).toBe('request errored');
  });

  it('serializes err with its own serializer', () => {
    expect(pinoHttp()['serializers']).toEqual({ err: serializeError });
  });

  // pino-http inventa un Error para todo 5xx que no le trae uno, con un stack
  // que apunta a su propio código. El error de verdad ya lo registró el filtro
  // de errores con el mismo id: la línea de la petición es de tráfico.
  describe('the line of a request that failed', () => {
    const errorObject = (): ErrorObject =>
      pinoHttp()['customErrorObject'] as ErrorObject;

    it('drops the error pino-http invents for a 5xx', () => {
      const invented = new Error('failed with status code 502');

      expect(
        errorObject()({}, { statusCode: 502 }, invented, {
          res: 'res',
          err: invented,
          responseTime: 3,
        }),
      ).toEqual({ res: 'res', responseTime: 3 });
    });

    it('keeps a real error', () => {
      const real = new Error('socket hang up');

      expect(
        errorObject()({}, { statusCode: 502 }, real, { err: real }),
      ).toEqual({ err: real });
    });

    it('keeps an error the response carries', () => {
      const carried = new Error('failed with status code 502');

      expect(
        errorObject()({}, { statusCode: 502, err: carried }, carried, {
          err: carried,
        }),
      ).toEqual({ err: carried });
    });
  });

  // pino escribe al descriptor 1 con sonic-boom, así que un destino propio es
  // la única forma de leer lo que emitió -- desde un test, o para escribir a
  // otro lado. Va como segundo elemento de la tupla, que es como lo espera
  // nestjs-pino.
  it('passes a destination through as the second element', () => {
    const destination = { write: vi.fn() };
    const params = createRequestLoggerOptions({ destination }).pinoHttp;

    expect(Array.isArray(params)).toBe(true);
    expect((params as [unknown, unknown])[1]).toBe(destination);
  });

  it('stays a plain object when no destination is given', () => {
    expect(Array.isArray(createRequestLoggerOptions().pinoHttp)).toBe(false);
  });

  // A container's log collector expects one JSON document per line, so pretty
  // printing must never be on by default.
  it('adds the pretty transport only when asked', () => {
    expect(pinoHttp()['transport']).toBeUndefined();
    expect(pinoHttp({ pretty: true })['transport']).toMatchObject({
      target: 'pino-pretty',
    });
  });
});

// pino-http pasa el error por el serializador estándar antes de entregarlo al
// propio (`wrapSerializers`), así que las pruebas parten de lo mismo.
describe('serializeError', () => {
  // El índice fija el tipo de un campo con la primera línea que ve y rechaza
  // entera la que traiga otro, y un error puede cargar datos que no debían
  // llegar al log: el cuerpo de error de un upstream, por ejemplo.
  it('keeps the type, the message and the stack, and nothing else', () => {
    const error = Object.assign(
      new HttpException('Upstream service error', 502),
      { body: { studentEmail: 'someone@example.edu' } },
    );

    const serialized = serializeError(stdSerializers.err(error));

    expect(Object.keys(serialized as object).sort()).toEqual([
      'message',
      'stack',
      'type',
    ]);
    expect(serialized).toMatchObject({
      type: 'HttpException',
      message: 'Upstream service error',
    });
    expect(JSON.stringify(serialized)).not.toContain('someone@example.edu');
  });

  it('keeps the causes in the message and in the stack', () => {
    const error = new Error('Upstream service error', {
      cause: new Error('connect ECONNREFUSED'),
    });

    const serialized = serializeError(stdSerializers.err(error)) as {
      message: string;
      stack: string;
    };

    expect(serialized.message).toBe(
      'Upstream service error: connect ECONNREFUSED',
    );
    expect(serialized.stack).toContain(
      'caused by: Error: connect ECONNREFUSED',
    );
  });

  it('keeps a system code, always as text', () => {
    const coded = (code: unknown): unknown =>
      serializeError(
        stdSerializers.err(Object.assign(new Error('failed'), { code })),
      );

    expect(coded('ECONNREFUSED')).toMatchObject({ code: 'ECONNREFUSED' });
    expect(coded(1062)).toMatchObject({ code: '1062' });
    expect(coded({ nested: true })).not.toHaveProperty('code');
  });

  it('serializes a raw Error the same way', () => {
    const error = new Error('boom');

    expect(serializeError(error)).toEqual(
      serializeError(stdSerializers.err(error)),
    );
  });

  // Un `err` que a veces es texto y a veces objeto es el mismo problema del
  // índice: siempre sale como objeto.
  it('turns a thrown value that is not an Error into a message', () => {
    expect(serializeError('boom')).toEqual({ message: 'boom' });
    expect(serializeError({ reason: 'boom' })).toEqual({
      message: "{ reason: 'boom' }",
    });
  });
});
