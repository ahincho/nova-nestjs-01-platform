import {
  DEFAULT_ERROR_CODE,
  INTERNAL_ERROR_CODE,
  NOVA_ERROR_CATALOG,
  VALIDATION_ERROR_CODE,
  errorCodeFor,
  statusToErrorCode,
  type ApiErrorCatalog,
} from './error-code';

describe('errorCodeFor', () => {
  const catalog: ApiErrorCatalog = {
    validation: 'INVALID_INPUT',
    byStatus: { 404: 'MISSING', 502: 'BAD_GATEWAY' },
    request: 'CLIENT_ERROR',
    internal: 'SERVER_ERROR',
  };

  // Un fallo de validación siempre es un 400, así que el status no alcanza para
  // nombrarlo: lo que lo distingue de un 400 cualquiera es el tipo.
  it('names a validation failure by its kind, not by its status', () => {
    expect(errorCodeFor(catalog, 400, 'validation')).toBe('INVALID_INPUT');
  });

  it('prefers the status the catalog names', () => {
    expect(errorCodeFor(catalog, 404, 'request')).toBe('MISSING');
  });

  it('falls back by the class of the status', () => {
    expect(errorCodeFor(catalog, 409, 'request')).toBe('CLIENT_ERROR');
    expect(errorCodeFor(catalog, 500, 'internal')).toBe('SERVER_ERROR');
  });

  // Nombrar un 5xx por su status es una decisión del catálogo: el status ya
  // viaja en la línea de estado, así que no revela nada que no se sepa.
  it('names a 5xx when the catalog chooses to', () => {
    expect(errorCodeFor(catalog, 502, 'internal')).toBe('BAD_GATEWAY');
  });

  it('keeps the Nova catalog behind statusToErrorCode', () => {
    expect(errorCodeFor(NOVA_ERROR_CATALOG, 400, 'validation')).toBe(
      VALIDATION_ERROR_CODE,
    );
    expect(errorCodeFor(NOVA_ERROR_CATALOG, 404, 'request')).toBe(
      statusToErrorCode(404),
    );
  });
});

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
