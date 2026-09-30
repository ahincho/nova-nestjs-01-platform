import { ApplicationError } from './application-error';
import { DomainError } from './domain-error';
import { InfrastructureError } from './infrastructure-error';
import { Layer } from './layer';
import {
  DEFAULT_INTERNAL_ERROR_MESSAGE,
  NovaErrorCatalog,
} from './nova-error-catalog';
import { PlatformError } from './platform-error';

describe('NovaErrorCatalog', () => {
  const catalog = new NovaErrorCatalog();

  it('answers a 4xx with the own code of the error and its message', () => {
    expect(
      catalog.describe(
        DomainError.notFound('Pedido no encontrado', {
          code: 'ORDER_NOT_FOUND',
        }),
        404,
      ),
    ).toEqual({ code: 'ORDER_NOT_FOUND', message: 'Pedido no encontrado' });
  });

  it('answers a 4xx without an own code with the code of the platform', () => {
    expect(
      catalog.describe(ApplicationError.forbidden('Sin permiso'), 403),
    ).toEqual({ code: 'FORBIDDEN', message: 'Sin permiso' });
  });

  it('names a 4xx the platform table does not with the generic code', () => {
    expect(
      catalog.describe(
        { layer: Layer.APPLICATION, message: 'teapot', fieldErrors: [] },
        418,
      ).code,
    ).toBe('REQUEST_ERROR');
  });

  // El código propio, el mensaje y el proveedor cuentan qué falló por dentro.
  it('answers a 5xx with the code of its status and the generic message', () => {
    const error = InfrastructureError.timeout('academic-orchestrator', {
      code: 'ACADEMIC_TIMEOUT',
      message: 'academic-orchestrator took 5000 ms',
    });

    const description = catalog.describe(error, 504);

    expect(description).toEqual({
      code: 'GATEWAY_TIMEOUT',
      message: DEFAULT_INTERNAL_ERROR_MESSAGE,
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
    expect(catalog.describe(PlatformError.internal('x'), status).code).toBe(
      code,
    );
  });

  it('answers every 5xx with the message it was configured with', () => {
    const spanish = new NovaErrorCatalog({
      internalErrorMessage: 'Error interno del servidor',
    });

    expect(spanish.describe(PlatformError.internal('x'), 500).message).toBe(
      'Error interno del servidor',
    );
  });
});
