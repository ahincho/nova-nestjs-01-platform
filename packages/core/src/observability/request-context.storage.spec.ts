import { RequestContextService } from './request-context.service';
import {
  currentRequestId,
  requestContextStorage,
} from './request-context.storage';

describe('the request context storage', () => {
  it('reads nothing outside a request', () => {
    expect(currentRequestId()).toBeUndefined();
  });

  it('reads the id of the request in flight', () => {
    requestContextStorage.run({ requestId: 'req-1', headers: {} }, () => {
      expect(currentRequestId()).toBe('req-1');
    });
  });

  // Es lo que le permite a un error de Nova tomar el traceId sin pasar por la
  // inyección: el contexto que abre el servicio es el mismo que se lee acá.
  it('is the storage the request context service opens', () => {
    const service = new RequestContextService();

    service.run({ requestId: 'req-2', headers: {} }, () => {
      expect(currentRequestId()).toBe('req-2');
    });
  });

  // Uno por proceso no mezcla peticiones: el valor es por cadena asíncrona.
  it('keeps two concurrent requests apart', async () => {
    const first = requestContextStorage.run(
      { requestId: 'req-1', headers: {} },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentRequestId();
      },
    );
    const second = requestContextStorage.run(
      { requestId: 'req-2', headers: {} },
      () => currentRequestId(),
    );

    expect([await first, second]).toEqual(['req-1', 'req-2']);
  });
});
