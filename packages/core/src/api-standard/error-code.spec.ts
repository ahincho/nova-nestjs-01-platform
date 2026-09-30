import {
  DEFAULT_ERROR_CODE,
  INTERNAL_ERROR_CODE,
  statusToErrorCode,
} from './error-code';

describe('statusToErrorCode', () => {
  // El catálogo de la plataforma de ADR-031, entero: es el mismo en los tres
  // stacks, así que una fila que falta acá es una diferencia entre ellos.
  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [405, 'METHOD_NOT_ALLOWED'],
    [406, 'NOT_ACCEPTABLE'],
    [408, 'REQUEST_TIMEOUT'],
    [409, 'CONFLICT'],
    [410, 'GONE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [422, 'UNPROCESSABLE_ENTITY'],
    [429, 'TOO_MANY_REQUESTS'],
    [500, 'INTERNAL_SERVER_ERROR'],
    [502, 'BAD_GATEWAY'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'GATEWAY_TIMEOUT'],
  ])('maps %i to %s', (status, expected) => {
    expect(statusToErrorCode(status)).toBe(expected);
  });

  it('falls back to the generic code for an unnamed 4xx', () => {
    expect(statusToErrorCode(418)).toBe(DEFAULT_ERROR_CODE);
  });

  // Sólo los tres 5xx que le dicen al cliente si conviene reintentar tienen
  // nombre propio; el resto no le cuenta nada más que un 500.
  it.each([501, 505, 599])(
    'falls back to the internal code for an unnamed %i',
    (status) => {
      expect(statusToErrorCode(status)).toBe(INTERNAL_ERROR_CODE);
    },
  );
});
