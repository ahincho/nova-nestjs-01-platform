import { RequestContextService } from './request-context.service';
import type { RequestContext } from './request-context';

const context: RequestContext = {
  requestId: 'req-1',
  headers: { 'x-request-id': 'req-1', 'x-user-id': 'u-9' },
};

describe('RequestContextService', () => {
  let service: RequestContextService;

  beforeEach(() => {
    service = new RequestContextService();
  });

  it('exposes the context to everything running underneath', () => {
    service.run(context, () => {
      expect(service.get()).toEqual(context);
      expect(service.requestId()).toBe('req-1');
    });
  });

  // The point of AsyncLocalStorage over a plain field: the context survives an
  // await without being threaded through every signature.
  it('survives an await', async () => {
    await service.run(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(service.requestId()).toBe('req-1');
    });
  });

  it('keeps two concurrent requests apart', async () => {
    const other: RequestContext = {
      requestId: 'req-2',
      headers: { 'x-request-id': 'req-2' },
    };

    // El primero arranca y queda suspendido en el await; el segundo corre
    // entero mientras tanto. Devuelve una cadena y no una promesa, y por eso
    // no van juntos en un Promise.all: lo que se prueba es que el segundo, que
    // corre en el medio, no ve el contexto del primero.
    const first = service.run(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return service.requestId();
    });
    const second = service.run(other, () => service.requestId());

    expect([await first, second]).toEqual(['req-1', 'req-2']);
  });

  // A scheduled job has no incoming call to correlate with, and inventing one
  // makes a trace claim a relationship that does not exist.
  it('reports nothing outside a request', () => {
    expect(service.get()).toBeUndefined();
    expect(service.requestId()).toBeUndefined();
    expect(service.headers()).toEqual({});
  });

  it('satisfies the outbound headers port', () => {
    service.run(context, () => {
      expect(service.headers()).toEqual({
        'x-request-id': 'req-1',
        'x-user-id': 'u-9',
      });
    });
  });

  // Handing out the stored object would let one caller's mutation reach every
  // later request on the same context.
  it('hands out a copy of the headers', () => {
    service.run(context, () => {
      const headers = service.headers();
      headers['x-request-id'] = 'tampered';

      expect(service.headers()['x-request-id']).toBe('req-1');
    });
  });

  describe('enrich', () => {
    // Lo que se sabe después de abrir el contexto: el middleware corre antes
    // que cualquier guard, así que el usuario todavía no existe al crearlo.
    it('adds a header to the request in flight', () => {
      service.run(context, () => {
        service.enrich({ 'x-user-id': 'U12345' });

        expect(service.headers()).toEqual({
          'x-request-id': 'req-1',
          'x-user-id': 'U12345',
        });
      });
    });

    it('survives an await', async () => {
      await service.run(context, async () => {
        service.enrich({ 'x-user-id': 'U12345' });
        await new Promise((resolve) => setTimeout(resolve, 1));

        expect(service.headers()['x-user-id']).toBe('U12345');
      });
    });

    it('keeps the correlation id it was given', () => {
      service.run(context, () => {
        service.enrich({ 'x-user-id': 'U12345' });

        expect(service.requestId()).toBe('req-1');
      });
    });

    // Un trabajo programado no tiene contexto que enriquecer, y abrir uno acá
    // dejaría un contexto que nadie cierra.
    it('does nothing outside a request', () => {
      expect(() => service.enrich({ 'x-user-id': 'U12345' })).not.toThrow();
      expect(service.headers()).toEqual({});
    });
  });

  describe('remove', () => {
    it('drops a header from the request in flight', () => {
      service.run(context, () => {
        service.remove(['x-user-id']);

        expect(service.headers()).toEqual({ 'x-request-id': 'req-1' });
      });
    });

    it('matches the name whatever its case', () => {
      service.run(context, () => {
        service.remove(['X-User-Id']);

        expect(service.headers()).not.toHaveProperty('x-user-id');
      });
    });

    it('survives an await', async () => {
      await service.run(context, async () => {
        service.remove(['x-user-id']);
        await Promise.resolve();

        expect(service.headers()).toEqual({ 'x-request-id': 'req-1' });
      });
    });

    it('leaves the context it was given untouched', () => {
      service.run(context, () => {
        service.remove(['x-user-id']);
      });

      expect(context.headers).toHaveProperty('x-user-id', 'u-9');
    });

    it('does nothing outside a request', () => {
      expect(() => service.remove(['x-user-id'])).not.toThrow();
    });
  });
});
