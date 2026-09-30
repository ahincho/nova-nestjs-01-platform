import { ApplicationError } from './application-error';
import { DomainError } from './domain-error';
import { InfrastructureError } from './infrastructure-error';
import { NovaErrorSerializer } from './nova-error-serializer';

describe('NovaErrorSerializer', () => {
  const serializer = new NovaErrorSerializer();

  it('answers with the Nova envelope and the traceId in metadata', () => {
    const { body, headers } = serializer.serialize(
      DomainError.notFound('Pedido no encontrado'),
      {
        status: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Pedido no encontrado',
        traceId: 'trace-1',
      },
    );

    expect(body).toEqual({
      success: false,
      status: 404,
      data: null,
      errors: [
        {
          code: 'ORDER_NOT_FOUND',
          message: 'Pedido no encontrado',
          field: null,
        },
      ],
      metadata: { traceId: 'trace-1' },
    });
    expect(headers).toEqual({});
  });

  // La clave está siempre, para que quien la lee no tenga que preguntar si existe.
  it('writes a null traceId when there is none', () => {
    const { body } = serializer.serialize(DomainError.notFound('x'), {
      status: 404,
      code: 'NOT_FOUND',
      message: 'x',
    });

    expect(body).toMatchObject({ metadata: { traceId: null } });
  });

  it('writes Retry-After in seconds', () => {
    const { headers } = serializer.serialize(
      ApplicationError.rateLimited('Demasiadas solicitudes', {
        retryAfter: 30,
      }),
      { status: 429, code: 'TOO_MANY_REQUESTS', message: 'x' },
    );

    expect(headers).toEqual({ 'Retry-After': '30' });
  });

  it('writes Retry-After on a 5xx too, for an unavailable upstream', () => {
    const { headers } = serializer.serialize(
      InfrastructureError.unavailable('payments', { retryAfter: 10 }),
      { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'x' },
    );

    expect(headers).toEqual({ 'Retry-After': '10' });
  });

  describe('field errors', () => {
    const invalid = ApplicationError.invalidInput('La entrada no es válida', [
      { field: 'periodId', message: 'Debe ser un entero' },
      { field: 'email', code: 'EMAIL_TAKEN', message: 'Ya está registrado' },
    ]);

    // Una entrada por campo, con su nombre: es lo que deja al formulario marcar
    // el input exacto. Sin código propio, el campo lleva el del error.
    it('answers one entry per field', () => {
      const { body } = serializer.serialize(invalid, {
        status: 400,
        code: 'BAD_REQUEST',
        message: 'La entrada no es válida',
      });

      expect(body).toMatchObject({
        errors: [
          {
            code: 'BAD_REQUEST',
            message: 'Debe ser un entero',
            field: 'periodId',
          },
          {
            code: 'EMAIL_TAKEN',
            message: 'Ya está registrado',
            field: 'email',
          },
        ],
      });
    });

    // Aunque un mapper propio lleve un error de entrada a un 5xx, el cuerpo de
    // un 5xx no cuenta nada más que su código genérico.
    it('never lists them in a 5xx', () => {
      const { body } = serializer.serialize(invalid, {
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
      });

      expect(body).toMatchObject({
        errors: [
          {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Internal server error',
            field: null,
          },
        ],
      });
    });
  });
});
