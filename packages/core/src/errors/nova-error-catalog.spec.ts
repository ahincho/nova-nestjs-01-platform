import { statusToErrorMessage } from '../api-standard/error-message';
import { ApplicationError } from './application-error';
import { DomainError } from './domain-error';
import { InfrastructureError } from './infrastructure-error';
import { Layer } from './layer';
import { NovaErrorCatalog } from './nova-error-catalog';
import type { NovaError } from './nova-error';
import { PlatformError } from './platform-error';
import type { SanitizedError } from './ports';

/**
 * El error como lo recibe el catálogo: saneado. Se arma con todo lo que el error
 * trae, incluso para un 5xx, para probar que el catálogo mismo no lo usa.
 */
function sanitized(error: NovaError): SanitizedError {
  return {
    kind: 'request',
    layer: error.layer,
    type: error.type,
    code: error.code,
    message: error.message,
    fieldErrors: error.fieldErrors,
  };
}

describe('NovaErrorCatalog', () => {
  const catalog = new NovaErrorCatalog();

  it('answers a 4xx with the own code of the error and its message', () => {
    expect(
      catalog.describe(
        sanitized(
          DomainError.notFound('Pedido no encontrado', {
            code: 'ORDER_NOT_FOUND',
          }),
        ),
        404,
      ),
    ).toEqual({ code: 'ORDER_NOT_FOUND', message: 'Pedido no encontrado' });
  });

  it('answers a 4xx without an own code with the code of the platform', () => {
    expect(
      catalog.describe(
        sanitized(ApplicationError.forbidden('Sin permiso')),
        403,
      ),
    ).toEqual({ code: 'FORBIDDEN', message: 'Sin permiso' });
  });

  it('names a 4xx the platform table does not with the generic code', () => {
    expect(
      catalog.describe(
        {
          kind: 'request',
          layer: Layer.APPLICATION,
          type: undefined,
          code: undefined,
          message: 'teapot',
          fieldErrors: [],
        },
        418,
      ).code,
    ).toBe('REQUEST_ERROR');
  });

  // El código propio, el mensaje y el proveedor cuentan qué falló por dentro.
  it('answers a 5xx with the code and the message of its status', () => {
    const error = InfrastructureError.timeout('academic-orchestrator', {
      code: 'ACADEMIC_TIMEOUT',
      message: 'academic-orchestrator took 5000 ms',
    });

    const description = catalog.describe(sanitized(error), 504);

    expect(description).toEqual({
      code: 'GATEWAY_TIMEOUT',
      message: statusToErrorMessage(504),
    });
    expect(JSON.stringify(description)).not.toContain('academic');
  });

  it.each([
    [500, 'INTERNAL_SERVER_ERROR'],
    [502, 'BAD_GATEWAY'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'GATEWAY_TIMEOUT'],
    [501, 'INTERNAL_SERVER_ERROR'],
    [599, 'INTERNAL_SERVER_ERROR'],
  ])('answers a %i with %s', (status, code) => {
    expect(
      catalog.describe(sanitized(PlatformError.internal('x')), status).code,
    ).toBe(code);
  });

  it('answers every 5xx with the message it was configured with', () => {
    const configured = new NovaErrorCatalog({
      internalErrorMessage: 'Algo falló de nuestro lado',
    });

    expect(
      configured.describe(sanitized(PlatformError.internal('x')), 503).message,
    ).toBe('Algo falló de nuestro lado');
  });
});
