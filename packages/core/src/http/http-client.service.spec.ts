import { HttpException, Logger } from '@nestjs/common';
import { HttpClientService } from './http-client.service';
import {
  resolveNovaHttpOptions,
  type HttpTransport,
  type HttpTransportInit,
  type OutboundHeadersProvider,
} from './tokens';
import { UpstreamException, type UpstreamFailure } from './upstream-failure';
import { UpstreamHttpError } from './upstream-http.error';
import type { Mock } from 'vitest';

type FetchArgs = [string, HttpTransportInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-upstream': 'academic' },
  });
}

/** Un error de red como los que lanza `fetch`: la causa real va adentro. */
function networkError(code: string, name = 'Error'): Error {
  const cause = Object.assign(new Error(code), { code, name });
  return new TypeError('fetch failed', { cause });
}

function timeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

/** Una respuesta cuyo cuerpo se corta al leerlo, como la de un socket caído. */
function brokenBodyResponse(): Response {
  const response = new Response('{"id":');
  vi.spyOn(response, 'text').mockRejectedValue(
    new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      }),
    }),
  );
  return response;
}

async function exceptionOf(call: Promise<unknown>): Promise<UpstreamException> {
  const error: unknown = await call.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(UpstreamException);
  return error as UpstreamException;
}

async function failureOf(call: Promise<unknown>): Promise<UpstreamFailure> {
  return (await exceptionOf(call)).failure;
}

describe('HttpClientService', () => {
  let transport: Mock<HttpTransport>;

  beforeEach(() => {
    transport = vi.fn<HttpTransport>();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function client(
    headersProvider?: OutboundHeadersProvider,
    timeoutMs = 5000,
  ): HttpClientService {
    return new HttpClientService(
      resolveNovaHttpOptions({ defaultTimeoutMs: timeoutMs }),
      headersProvider,
      undefined,
      transport,
    );
  }

  function lastCall(): FetchArgs {
    return transport.mock.calls[transport.mock.calls.length - 1] as FetchArgs;
  }

  describe('a successful call', () => {
    it('parses the JSON body', async () => {
      transport.mockResolvedValue(jsonResponse({ id: 7 }));

      await expect(
        client().get('http://academic.internal/courses'),
      ).resolves.toEqual({ id: 7 });
    });

    // The body has to be null, not '': a Response with a null-body status and
    // any body at all throws on construction.
    it('returns undefined for an empty body', async () => {
      transport.mockResolvedValue(new Response(null, { status: 204 }));

      await expect(
        client().delete('http://academic.internal/courses/7'),
      ).resolves.toBeUndefined();
    });

    it('serialises the body of a POST', async () => {
      transport.mockResolvedValue(jsonResponse({ ok: true }, 201));

      await client().post('http://academic.internal/enrollments', {
        studentId: 7,
      });

      expect(lastCall()[1].body).toBe('{"studentId":7}');
      expect(lastCall()[1].method).toBe('POST');
    });

    it('sends no body on a GET', async () => {
      transport.mockResolvedValue(jsonResponse({}));

      await client().get('http://academic.internal/courses');

      expect(lastCall()[1].body).toBeUndefined();
    });

    // Sin transporte inyectado el cliente sigue llamando de verdad: es el
    // default para quien lo construye a mano.
    it('falls back to the real fetch when nothing is injected', () => {
      const bare = new HttpClientService(resolveNovaHttpOptions());

      expect(bare).toBeInstanceOf(HttpClientService);
    });
  });

  describe('the query string', () => {
    it('appends the entries that carry a value', async () => {
      transport.mockResolvedValue(jsonResponse([]));

      await client().get('http://academic.internal/courses', {
        query: { periodId: 202, active: true, search: undefined, tag: null },
      });

      expect(lastCall()[0]).toBe(
        'http://academic.internal/courses?periodId=202&active=true',
      );
    });

    it('joins onto a URL that already has a query', async () => {
      transport.mockResolvedValue(jsonResponse([]));

      await client().get('http://academic.internal/courses?page=1', {
        query: { size: 20 },
      });

      expect(lastCall()[0]).toBe(
        'http://academic.internal/courses?page=1&size=20',
      );
    });

    it('leaves the URL alone when every entry is empty', async () => {
      transport.mockResolvedValue(jsonResponse([]));

      await client().get('http://academic.internal/courses', {
        query: { search: undefined },
      });

      expect(lastCall()[0]).toBe('http://academic.internal/courses');
    });
  });

  describe('headers', () => {
    // This is the whole point of the provider: no call site passes the
    // correlation id, and every outbound call still carries it.
    it('propagates what the provider supplies', async () => {
      transport.mockResolvedValue(jsonResponse({}));

      await client({
        headers: () => ({ 'x-request-id': 'req-1', 'x-user-id': 'u-9' }),
      }).get('http://academic.internal/courses');

      expect(lastCall()[1].headers).toMatchObject({
        'x-request-id': 'req-1',
        'x-user-id': 'u-9',
      });
    });

    it('lets the call site override a propagated header', async () => {
      transport.mockResolvedValue(jsonResponse({}));

      await client({ headers: () => ({ 'x-request-id': 'req-1' }) }).get(
        'http://academic.internal/courses',
        { headers: { 'x-request-id': 'req-override' } },
      );

      expect(lastCall()[1].headers).toMatchObject({
        'x-request-id': 'req-override',
      });
    });

    // Losing the correlation id degrades a trace; failing the call because the
    // context could not be read would turn that into an outage.
    it('still calls when the provider throws', async () => {
      transport.mockResolvedValue(jsonResponse({ id: 7 }));

      const provider: OutboundHeadersProvider = {
        headers: () => {
          throw new Error('no request context');
        },
      };

      await expect(
        client(provider).get('http://academic.internal/courses'),
      ).resolves.toEqual({ id: 7 });
      // La causa va como campo, y el mensaje queda uno solo para agrupar.
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        { err: new Error('no request context') },
        'Could not build the propagated headers',
      );
    });

    it('defaults the content type to JSON', async () => {
      transport.mockResolvedValue(jsonResponse({}));

      await client().get('http://academic.internal/courses');

      expect(lastCall()[1].headers).toMatchObject({
        'content-type': 'application/json',
      });
    });
  });

  describe('a failure before any response', () => {
    // Cada código sale de provocar el fallo contra un servidor real con
    // undici 8.10; acá se fija la traducción, y la prueba de integración
    // comprueba que undici siga lanzando esos códigos.
    it.each([
      ['ECONNREFUSED', 'connection_refused', 'connectivity', 'connect', 502],
      ['ENOTFOUND', 'dns_error', 'connectivity', 'connect', 502],
      ['EAI_AGAIN', 'dns_timeout', 'connectivity', 'connect', 504],
      [
        'EHOSTUNREACH',
        'destination_ip_unroutable',
        'connectivity',
        'connect',
        502,
      ],
      [
        'UND_ERR_CONNECT_TIMEOUT',
        'connection_timeout',
        'connectivity',
        'connect',
        504,
      ],
      [
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'tls_certificate_error',
        'connectivity',
        'connect',
        502,
      ],
      [
        'ERR_SSL_WRONG_VERSION_NUMBER',
        'tls_protocol_error',
        'connectivity',
        'connect',
        502,
      ],
      [
        'UND_ERR_HEADERS_TIMEOUT',
        'http_response_timeout',
        'timeout',
        'response',
        504,
      ],
      ['UND_ERR_SOCKET', 'connection_terminated', 'network', 'response', 502],
      ['ECONNRESET', 'connection_terminated', 'network', 'response', 502],
    ])('classifies %s as %s', async (code, type, category, phase, status) => {
      transport.mockRejectedValue(networkError(code));

      await expect(
        failureOf(client().get('http://academic.internal/courses')),
      ).resolves.toMatchObject({ type, category, phase, status, code });
    });

    it('classifies a response that is not HTTP as a protocol error', async () => {
      transport.mockRejectedValue(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('Response does not match'), {
            name: 'HTTPParserError',
          }),
        }),
      );

      await expect(
        failureOf(client().get('http://academic.internal/courses')),
      ).resolves.toMatchObject({
        type: 'http_protocol_error',
        category: 'network',
        status: 502,
      });
    });

    // El plazo propio llega sin envolver, y es un 504 como siempre.
    it('classifies its own timeout as a response timeout', async () => {
      transport.mockRejectedValue(timeoutError());

      await expect(
        failureOf(client().get('http://academic.internal/courses')),
      ).resolves.toMatchObject({
        type: 'http_response_timeout',
        category: 'timeout',
        status: 504,
      });
    });

    // Un error sin causa reconocible casi siempre nació antes de salir, así que
    // es un 500 nuestro y no un 502 del upstream.
    it('blames itself for a failure it does not recognise', async () => {
      transport.mockRejectedValue(new TypeError('invalid header value'));

      await expect(
        failureOf(client().get('http://academic.internal/courses')),
      ).resolves.toMatchObject({
        type: 'proxy_internal_error',
        category: 'internal',
        status: 500,
      });
    });

    it('blames itself for a body it cannot serialise', async () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      await expect(
        failureOf(client().post('http://academic.internal/x', circular)),
      ).resolves.toMatchObject({ category: 'internal', status: 500 });
      expect(transport).not.toHaveBeenCalled();
    });

    it('is still an HttpException with the status of its type', async () => {
      transport.mockRejectedValue(networkError('ECONNREFUSED'));

      const error: unknown = await client()
        .get('http://academic.internal/courses')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(502);
    });
  });

  describe('a failure while reading the body', () => {
    // Antes esto salía como un TypeError sin traducir, y el filtro lo
    // contestaba 500: un problema de red contado como defecto propio.
    it('reports a body cut halfway as an incomplete response', async () => {
      transport.mockResolvedValue(brokenBodyResponse());

      await expect(
        failureOf(client().get('http://academic.internal/courses')),
      ).resolves.toMatchObject({
        type: 'http_response_incomplete',
        category: 'network',
        phase: 'body',
        status: 502,
      });
    });

    it('reports a 2xx body that is not JSON as a broken contract', async () => {
      transport.mockResolvedValue(
        new Response('<html>Service Unavailable</html>'),
      );

      await expect(
        failureOf(client().get('http://academic.internal/courses')),
      ).resolves.toMatchObject({
        type: 'http_response_content_invalid',
        category: 'contract',
        phase: 'body',
        status: 502,
      });
    });
  });

  describe('an upstream that answers with an error', () => {
    // The upstream's own status describes a topology the client should not
    // learn about, so a 404 from the upstream is not a 404 to the caller.
    it.each([400, 401, 403, 404, 409, 500, 503])(
      'hides an upstream %i behind a 502',
      async (status) => {
        transport.mockResolvedValue(jsonResponse({ detail: 'x' }, status));

        await expect(
          failureOf(client().get('http://academic.internal/courses')),
        ).resolves.toMatchObject({
          category: 'response',
          receivedStatus: status,
          status: 502,
        });
      },
    );

    it.each([408, 504])('reports an upstream %i as a 504', async (status) => {
      transport.mockResolvedValue(jsonResponse({}, status));

      await expect(
        failureOf(client().get('http://academic.internal/courses')),
      ).resolves.toMatchObject({ receivedStatus: status, status: 504 });
    });

    it('carries no RFC type, since the upstream did answer', async () => {
      transport.mockResolvedValue(jsonResponse({}, 503));

      const failure = await failureOf(
        client().get('http://academic.internal/courses'),
      );

      expect(failure.type).toBeUndefined();
    });

    it('hands the caller the whole response when it asks to forward', async () => {
      transport.mockResolvedValue(
        jsonResponse({ code: 'STUDENT_NOT_FOUND' }, 404),
      );

      await expect(
        client().get('http://academic.internal/students/7', {
          forwardError: true,
        }),
      ).rejects.toMatchObject({
        name: 'UpstreamHttpError',
        statusCode: 404,
        body: { code: 'STUDENT_NOT_FOUND' },
        headers: expect.objectContaining({ 'x-upstream': 'academic' }),
      });
    });

    // En un error pedido por el llamador el texto sí vale: un gateway que
    // contesta HTML es lo habitual, y el llamador decide qué hacer.
    it('forwards an error body that is not JSON as text', async () => {
      transport.mockResolvedValue(
        new Response('<html>502</html>', { status: 502 }),
      );

      await expect(
        client().get('http://academic.internal/x', { forwardError: true }),
      ).rejects.toMatchObject({ body: '<html>502</html>' });
    });

    it('raises UpstreamHttpError, not a plain Error', async () => {
      transport.mockResolvedValue(jsonResponse({}, 422));

      await expect(
        client().get('http://academic.internal/x', { forwardError: true }),
      ).rejects.toBeInstanceOf(UpstreamHttpError);
    });

    // El patrón de siempre es traducir el status que se entiende y relanzar el
    // resto. Cuando el error pedido era un `Error` suelto, lo relanzado llegaba
    // al filtro como un fallo propio y salía 500.
    it.each([
      [503, 502],
      [504, 504],
    ])(
      'classifies a forwarded %i the caller rethrows as a %i',
      async (received, answered) => {
        transport.mockResolvedValue(jsonResponse({}, received));

        const error = await exceptionOf(
          client().get('http://academic.internal/x', { forwardError: true }),
        );

        expect(error).toBeInstanceOf(UpstreamHttpError);
        expect(error.getStatus()).toBe(answered);
        expect(error.message).toBe(`Upstream responded ${received}`);
        expect(error.failure).toMatchObject({
          upstream: 'academic.internal',
          category: 'response',
          phase: 'response',
          receivedStatus: received,
          status: answered,
        });
      },
    );
  });

  // El cliente no registra el fallo: lanza, y la excepción lleva los campos. Lo
  // registra una sola vez quien decide qué hacer con él -el filtro de errores
  // si nadie lo atrapa-. Registrarlo acá también dejaba dos líneas de error por
  // cada fallo, y una falsa cuando el llamador lo había resuelto.
  describe('logging', () => {
    it.each([
      [
        'a refused connection',
        () => transport.mockRejectedValue(networkError('ECONNREFUSED')),
      ],
      [
        'an upstream that answers 503',
        () => transport.mockResolvedValue(jsonResponse({}, 503)),
      ],
      [
        'a 2xx that is not JSON',
        () => transport.mockResolvedValue(new Response('<html></html>')),
      ],
    ])('leaves no line of its own for %s', async (_, arrange) => {
      arrange();

      await exceptionOf(client().get('http://academic.internal/courses'));

      expect(Logger.prototype.error).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    // El 404 que el llamador pidió para traducirlo no es un error de nadie.
    it('leaves no line for an error the caller asked to receive', async () => {
      transport.mockResolvedValue(jsonResponse({}, 404));

      await client()
        .get('http://academic.internal/students/7', { forwardError: true })
        .catch(() => undefined);

      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    // La clasificación va como campos, no dentro del mensaje: un tablero cuenta
    // por categoría sin parsear texto.
    it('hands the classification and the call to the log line', async () => {
      transport.mockRejectedValue(networkError('ECONNREFUSED'));

      const error = await exceptionOf(
        client().get('http://academic.internal/courses/7?token=abc', {
          timeoutMs: 800,
        }),
      );

      expect(error.logFields).toEqual({
        upstream: expect.objectContaining({
          upstream: 'academic.internal',
          type: 'connection_refused',
          category: 'connectivity',
          code: 'ECONNREFUSED',
        }),
        outbound: {
          method: 'GET',
          url: 'http://academic.internal/courses/7',
          timeoutMs: 800,
        },
      });
    });

    // An upstream error payload routinely echoes back the identifiers of the
    // person the request was about, and a query string carries them outright.
    it.each([false, true])(
      'never hands the body or the query string to the log (forwardError: %s)',
      async (forwardError) => {
        transport.mockResolvedValue(
          jsonResponse({ studentEmail: 'someone@example.edu' }, 500),
        );

        const error = await exceptionOf(
          client().get('http://user:s3cr3t@academic.internal/students', {
            query: { documentNumber: '70123456' },
            forwardError,
          }),
        );

        const logged = JSON.stringify(error.logFields);
        expect(logged).not.toContain('someone@example.edu');
        expect(logged).not.toContain('70123456');
        expect(logged).not.toContain('s3cr3t');
        expect(logged).toContain('http://academic.internal/students');
      },
    );

    it('names the upstream by its host only', async () => {
      transport.mockRejectedValue(networkError('ECONNREFUSED'));

      const failure = await failureOf(
        client().get(
          'http://user:pass@academic.internal:8080/students/70123456',
        ),
      );

      expect(failure.upstream).toBe('academic.internal:8080');
    });
  });

  describe('timeouts', () => {
    it('applies the module default', async () => {
      transport.mockResolvedValue(jsonResponse({}));

      await client(undefined, 1500).get('http://academic.internal/courses');

      expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
    });

    it('lets the call site override it', async () => {
      transport.mockResolvedValue(jsonResponse({}));

      await client(undefined, 1500).get('http://academic.internal/courses', {
        timeoutMs: 50,
      });

      expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
    });
  });
});
