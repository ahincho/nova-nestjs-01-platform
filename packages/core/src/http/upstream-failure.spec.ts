import { HttpException } from '@nestjs/common';
import {
  UpstreamException,
  categoryForType,
  classifyTransportError,
  statusForType,
  type UpstreamErrorType,
  type UpstreamFailure,
} from './upstream-failure';

function wrapped(code: string): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(code), { code }),
  });
}

const FAILURE: UpstreamFailure = {
  upstream: 'academic.internal',
  category: 'connectivity',
  type: 'connection_refused',
  code: 'ECONNREFUSED',
  phase: 'connect',
  elapsedMs: 3,
  status: 502,
};

describe('classifyTransportError', () => {
  // `fetch` envuelve el fallo real en un TypeError; lo que se clasifica es la
  // causa, no el envoltorio.
  it('reads the code from inside the fetch wrapper', () => {
    expect(classifyTransportError(wrapped('ECONNREFUSED'), 'request')).toEqual({
      type: 'connection_refused',
      category: 'connectivity',
      code: 'ECONNREFUSED',
    });
  });

  // La misma conexión cortada dice cosas distintas según cuándo pasó.
  it('tells a connection cut before the response from one cut in the body', () => {
    expect(
      classifyTransportError(wrapped('UND_ERR_SOCKET'), 'request').type,
    ).toBe('connection_terminated');
    expect(classifyTransportError(wrapped('UND_ERR_SOCKET'), 'body').type).toBe(
      'http_response_incomplete',
    );
  });

  it('recognises its own deadline in any phase', () => {
    const timeout = Object.assign(new Error('aborted'), {
      name: 'TimeoutError',
    });

    expect(classifyTransportError(timeout, 'request').type).toBe(
      'http_response_timeout',
    );
    expect(classifyTransportError(timeout, 'body').type).toBe(
      'http_response_timeout',
    );
  });

  // El estándar de fetch prohíbe algunos puertos y los rechaza sin código, sólo
  // con el mensaje. Es configuración nuestra, no un defecto ni la red.
  it('recognises a port that fetch refuses as a configuration error', () => {
    const refused = new TypeError('fetch failed', {
      cause: new Error('bad port'),
    });

    expect(classifyTransportError(refused, 'request')).toEqual({
      type: 'proxy_configuration_error',
      category: 'internal',
    });
  });

  it('keeps a raw code it does not recognise as data', () => {
    expect(classifyTransportError(wrapped('EWHATEVER'), 'request')).toEqual({
      type: 'proxy_internal_error',
      category: 'internal',
      code: 'EWHATEVER',
    });
  });

  it('stops walking a circular cause chain', () => {
    const error = new Error('loop') as Error & { cause?: unknown };
    error.cause = error;

    expect(classifyTransportError(error, 'request').type).toBe(
      'proxy_internal_error',
    );
  });

  it('tolerates something that is not an error at all', () => {
    expect(classifyTransportError('boom', 'request').category).toBe('internal');
  });
});

describe('the RFC 9209 table', () => {
  // Los timeouts de conexión y de DNS son 504, como recomienda el RFC; antes
  // salían 502, y es el cambio de status que anota ADR-035.
  it.each<[UpstreamErrorType, number]>([
    ['dns_timeout', 504],
    ['connection_timeout', 504],
    ['http_response_timeout', 504],
    ['connection_read_timeout', 504],
    ['connection_refused', 502],
    ['http_response_incomplete', 502],
    ['http_response_content_invalid', 502],
    ['proxy_internal_error', 500],
    ['proxy_configuration_error', 500],
  ])('answers %s with %i', (type, status) => {
    expect(statusForType(type)).toBe(status);
  });

  // La decisión más cara de equivocar: un timeout de conexión es conectividad.
  it('files a connection timeout under connectivity, not timeout', () => {
    expect(categoryForType('connection_timeout')).toBe('connectivity');
    expect(categoryForType('http_response_timeout')).toBe('timeout');
  });
});

describe('UpstreamException', () => {
  it('is an HttpException with the status of the failure', () => {
    const exception = new UpstreamException(FAILURE);

    expect(exception).toBeInstanceOf(HttpException);
    expect(exception.getStatus()).toBe(502);
    expect(exception.name).toBe('UpstreamException');
  });

  // El mensaje no dice nada del upstream: el detalle va al log.
  it('keeps a generic message and the detail for the log', () => {
    const exception = new UpstreamException(FAILURE);

    expect(exception.message).toBe('Upstream service error');
    expect(exception.logFields).toEqual({ upstream: FAILURE });
  });

  it.each([
    [504, 'Upstream service timed out'],
    [500, 'Upstream call could not be made'],
  ])('says %i generically', (status, message) => {
    expect(new UpstreamException({ ...FAILURE, status }).message).toBe(message);
  });

  it('keeps the original error as its cause', () => {
    const cause = new Error('connect ECONNREFUSED');

    expect(new UpstreamException(FAILURE, cause).cause).toBe(cause);
  });
});
