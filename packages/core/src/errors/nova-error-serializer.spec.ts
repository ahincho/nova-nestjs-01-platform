import type { ApiFailure } from '../api-standard/api-standard';
import { Layer } from './layer';
import { NovaErrorSerializer } from './nova-error-serializer';

/** El fallo ya saneado y descrito, como se lo pasa el filtro global. */
function failure(overrides: Partial<ApiFailure> = {}): ApiFailure {
  return {
    status: 404,
    kind: 'request',
    layer: Layer.DOMAIN,
    traceId: 'trace-1',
    retryAfter: undefined,
    errors: [
      { code: 'ORDER_NOT_FOUND', message: 'Pedido no encontrado', field: null },
    ],
    ...overrides,
  };
}

describe('NovaErrorSerializer', () => {
  const serializer = new NovaErrorSerializer();

  it('answers with the Nova envelope and the traceId in metadata', () => {
    const wire = serializer.serialize(failure());

    expect(wire.body).toEqual({
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
    expect(wire.headers).toBeUndefined();
  });

  // La clave está siempre, para que quien la lee no tenga que preguntar si existe.
  it('writes a null traceId when there is none', () => {
    expect(
      serializer.serialize(failure({ traceId: undefined })).body,
    ).toMatchObject({ metadata: { traceId: null } });
  });

  it('writes Retry-After in seconds, on a 4xx and on a 5xx', () => {
    expect(
      serializer.serialize(failure({ status: 429, retryAfter: 30 })).headers,
    ).toEqual({ 'Retry-After': '30' });
    expect(
      serializer.serialize(
        failure({ status: 503, layer: Layer.INFRASTRUCTURE, retryAfter: 10 }),
      ).headers,
    ).toEqual({ 'Retry-After': '10' });
  });

  // Una entrada por campo, con su nombre: es lo que deja al formulario marcar el
  // input exacto. El filtro ya las armó; el serializador no agrega ni quita.
  it('answers one entry per field, in order', () => {
    const { body } = serializer.serialize(
      failure({
        status: 400,
        kind: 'validation',
        layer: Layer.APPLICATION,
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
      }),
    );

    expect(body).toMatchObject({
      errors: [
        {
          code: 'BAD_REQUEST',
          message: 'Debe ser un entero',
          field: 'periodId',
        },
        { code: 'EMAIL_TAKEN', message: 'Ya está registrado', field: 'email' },
      ],
    });
  });

  // El filtro siempre trae el código; sin él, alguien llamó al serializador a mano.
  it('falls back to the code of the Nova catalog', () => {
    const { body } = serializer.serialize(
      failure({
        status: 503,
        kind: 'internal',
        layer: Layer.INFRASTRUCTURE,
        errors: [{ code: undefined, message: 'x', field: null }],
      }),
    );

    expect(body).toMatchObject({ errors: [{ code: 'SERVICE_UNAVAILABLE' }] });
  });
});
