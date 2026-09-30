import { requestContextStorage } from '../observability/request-context.storage';
import { ApplicationError } from './application-error';
import { DomainError } from './domain-error';
import {
  ApplicationErrorType,
  DomainErrorType,
  InfrastructureErrorType,
  PlatformErrorType,
} from './error-type';
import { InfrastructureError } from './infrastructure-error';
import { Layer } from './layer';
import { NovaError } from './nova-error';
import { PlatformError } from './platform-error';

function inRequest<T>(requestId: string, callback: () => T): T {
  return requestContextStorage.run({ requestId, headers: {} }, callback);
}

describe('the layered errors', () => {
  // Cada fábrica fija la capa y el tipo: quien lanza elige qué pasó, no el
  // status, que es justo lo que ata el dominio al transporte.
  it.each<[string, () => NovaError, Layer, string]>([
    [
      'DomainError.notFound',
      () => DomainError.notFound('x'),
      Layer.DOMAIN,
      DomainErrorType.NOT_FOUND,
    ],
    [
      'DomainError.conflict',
      () => DomainError.conflict('x'),
      Layer.DOMAIN,
      DomainErrorType.CONFLICT,
    ],
    [
      'DomainError.ruleViolation',
      () => DomainError.ruleViolation('x'),
      Layer.DOMAIN,
      DomainErrorType.RULE_VIOLATION,
    ],
    [
      'ApplicationError.invalidInput',
      () => ApplicationError.invalidInput('x'),
      Layer.APPLICATION,
      ApplicationErrorType.INVALID_INPUT,
    ],
    [
      'ApplicationError.conflict',
      () => ApplicationError.conflict('x'),
      Layer.APPLICATION,
      ApplicationErrorType.CONFLICT,
    ],
    [
      'ApplicationError.unprocessable',
      () => ApplicationError.unprocessable('x'),
      Layer.APPLICATION,
      ApplicationErrorType.UNPROCESSABLE,
    ],
    [
      'ApplicationError.unauthenticated',
      () => ApplicationError.unauthenticated('x'),
      Layer.APPLICATION,
      ApplicationErrorType.UNAUTHENTICATED,
    ],
    [
      'ApplicationError.forbidden',
      () => ApplicationError.forbidden('x'),
      Layer.APPLICATION,
      ApplicationErrorType.FORBIDDEN,
    ],
    [
      'ApplicationError.rateLimited',
      () => ApplicationError.rateLimited('x'),
      Layer.APPLICATION,
      ApplicationErrorType.RATE_LIMITED,
    ],
    [
      'InfrastructureError.unavailable',
      () => InfrastructureError.unavailable('u'),
      Layer.INFRASTRUCTURE,
      InfrastructureErrorType.UNAVAILABLE,
    ],
    [
      'InfrastructureError.timeout',
      () => InfrastructureError.timeout('u'),
      Layer.INFRASTRUCTURE,
      InfrastructureErrorType.TIMEOUT,
    ],
    [
      'InfrastructureError.badGateway',
      () => InfrastructureError.badGateway('u'),
      Layer.INFRASTRUCTURE,
      InfrastructureErrorType.BAD_GATEWAY,
    ],
    [
      'PlatformError.internal',
      () => PlatformError.internal('x'),
      Layer.PLATFORM,
      PlatformErrorType.INTERNAL,
    ],
  ])('%s is %s / %s', (_name, build, layer, type) => {
    const error = build();

    expect(error.layer).toBe(layer);
    expect(error.type).toBe(type);
  });

  it('is an Error, a NovaError and its own class', () => {
    const error = DomainError.notFound('Pedido no encontrado');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(NovaError);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('DomainError');
    expect(error.message).toBe('Pedido no encontrado');
  });

  // Un servicio que extiende una clase de capa para un caso propio lo ve con
  // su nombre en el log, no con el de la capa.
  it('names itself after the class that was thrown', () => {
    class OrderNotFound extends DomainError {
      constructor() {
        super(DomainErrorType.NOT_FOUND, 'Pedido no encontrado');
      }
    }

    expect(new OrderNotFound().name).toBe('OrderNotFound');
  });

  it('carries its own code only when given one', () => {
    expect(DomainError.notFound('x').code).toBeUndefined();
    expect(DomainError.notFound('x', { code: 'ORDER_NOT_FOUND' }).code).toBe(
      'ORDER_NOT_FOUND',
    );
  });

  it('never leaves the field errors undefined', () => {
    expect(DomainError.conflict('x').fieldErrors).toEqual([]);
  });

  it('carries the field errors of an invalid input', () => {
    const fieldErrors = [
      { field: 'periodId', message: 'Debe ser un entero' },
      { field: 'address.zipCode', code: 'ZIP', message: 'No es válido' },
    ];

    expect(
      ApplicationError.invalidInput('x', fieldErrors, { code: 'BAD_FORM' }),
    ).toMatchObject({ code: 'BAD_FORM', fieldErrors });
  });

  // Mutar la lista después de lanzar no puede cambiar lo que se va a contestar.
  it('keeps a copy of the field errors it was given', () => {
    const fieldErrors = [{ field: 'periodId', message: 'Debe ser un entero' }];
    const error = ApplicationError.invalidInput('x', fieldErrors);

    fieldErrors.push({ field: 'other', message: 'tampered' });

    expect(error.fieldErrors).toHaveLength(1);
  });

  it('keeps the cause, and has none when not given one', () => {
    const cause = new Error('socket hang up');

    expect(InfrastructureError.timeout('u', { cause }).cause).toBe(cause);
    expect('cause' in DomainError.notFound('x')).toBe(false);
  });

  describe('retryAfter', () => {
    it('is carried by the three that can be retried', () => {
      expect(ApplicationError.conflict('x', { retryAfter: 1 }).retryAfter).toBe(
        1,
      );
      expect(
        ApplicationError.rateLimited('x', { retryAfter: 30 }).retryAfter,
      ).toBe(30);
      expect(
        InfrastructureError.unavailable('u', { retryAfter: 5 }).retryAfter,
      ).toBe(5);
    });

    // Retry-After va en segundos enteros, y esperar de menos es volver a chocar.
    it('rounds a fraction up to the next second', () => {
      expect(
        ApplicationError.rateLimited('x', { retryAfter: 1.2 }).retryAfter,
      ).toBe(2);
    });

    // Lanzar al construir reemplazaría el error que se quería contestar.
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      'drops %s instead of throwing',
      (retryAfter) => {
        expect(
          ApplicationError.rateLimited('x', { retryAfter }).retryAfter,
        ).toBeUndefined();
      },
    );
  });

  describe('an infrastructure error', () => {
    it('names the upstream that failed', () => {
      expect(InfrastructureError.timeout('academic').upstream).toBe('academic');
    });

    it('writes a message for the log when given none', () => {
      expect(InfrastructureError.timeout('academic').message).toBe(
        'Upstream academic did not respond in time',
      );
      expect(InfrastructureError.unavailable('academic').message).toBe(
        'Upstream academic is unavailable',
      );
      expect(
        new InfrastructureError(InfrastructureErrorType.BAD_GATEWAY, undefined)
          .message,
      ).toBe('An upstream answered with an invalid response');
    });

    it('keeps the message it is given', () => {
      expect(
        InfrastructureError.badGateway('academic', {
          message: 'HTML, not JSON',
        }).message,
      ).toBe('HTML, not JSON');
    });
  });

  describe('the traceId', () => {
    it('is taken from the request in flight when the error is built', () => {
      const error = inRequest('trace-1', () => DomainError.notFound('x'));

      expect(error.traceId).toBe('trace-1');
    });

    // Se lee al nacer, así que sobrevive a que el contexto se termine.
    it('outlives the request it was taken from', async () => {
      const error = await inRequest('trace-1', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return DomainError.notFound('x');
      });

      expect(requestContextStorage.getStore()).toBeUndefined();
      expect(error.traceId).toBe('trace-1');
    });

    // Un job o un consumidor no tienen petición: sin contexto no hay traceId,
    // y construir el error no puede fallar por eso.
    it('is absent outside a request, and building the error does not throw', () => {
      expect(() => PlatformError.internal('x')).not.toThrow();
      expect(PlatformError.internal('x').traceId).toBeUndefined();
    });
  });
});
