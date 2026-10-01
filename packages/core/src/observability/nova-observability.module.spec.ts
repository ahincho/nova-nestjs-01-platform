import type { MiddlewareConsumer } from '@nestjs/common';
import { NovaObservabilityModule } from './nova-observability.module';
import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';
import { OBSERVABILITY_OPTIONS } from './tokens';

type ValueProvider = { provide?: unknown; useValue?: unknown };

describe('NovaObservabilityModule', () => {
  describe('forRoot', () => {
    it('provides the context service and the resolved options', () => {
      const module = NovaObservabilityModule.forRoot({ echoRequestId: false });
      const providers = (module.providers ?? []) as ValueProvider[];

      expect(providers).toContain(RequestContextService);
      expect(
        providers.find((provider) => provider.provide === OBSERVABILITY_OPTIONS)
          ?.useValue,
      ).toMatchObject({ echoRequestId: false });
    });

    // Global, because everything that logs or calls an upstream reads the
    // context, and importing this in every feature module would be noise.
    it('is global and exports the context service', () => {
      const module = NovaObservabilityModule.forRoot();

      expect(module.global).toBe(true);
      expect(module.exports?.slice(0, 2)).toEqual([
        RequestContextService,
        OBSERVABILITY_OPTIONS,
      ]);
    });

    // El logger va montado por defecto: el formato del documento de log es un
    // contrato con quien lo indexa, y un servicio que arma el suyo produce
    // líneas que llegan al índice y no aparecen en ninguna consulta.
    it('mounts the structured logger by default', () => {
      const module = NovaObservabilityModule.forRoot();

      expect(module.imports).toHaveLength(1);
      expect(module.exports).toHaveLength(3);
    });

    it('mounts nothing when the service logs its own way', () => {
      const module = NovaObservabilityModule.forRoot({ logger: false });

      expect(module.imports).toEqual([]);
      expect(module.exports).toEqual([
        RequestContextService,
        OBSERVABILITY_OPTIONS,
      ]);
    });

    // La cabecera del id no se declara dos veces: sale de la misma lista de
    // correlación, así que moverla mueve el contexto y el log juntos.
    it('gives the logger the correlation header the context uses', () => {
      const module = NovaObservabilityModule.forRoot({
        correlationHeaders: ['x-trace-id'],
      });
      const logger = module.imports?.[0] as {
        providers?: ValueProvider[];
      };
      const params = logger.providers?.find(
        (provider) => provider.provide === 'pino-params',
      )?.useValue as { pinoHttp: { genReqId: (r: unknown) => string } };

      expect(
        params.pinoHttp.genReqId({ headers: { 'x-trace-id': 'from-header' } }),
      ).toBe('from-header');
    });

    // Si pino mira antes que el contexto, tiene que llegar al mismo id: por eso
    // lee las cabeceras del borde en el mismo orden.
    it('gives the logger the headers the edge accepts, in order', () => {
      const module = NovaObservabilityModule.forRoot({
        requestId: { accept: ['transaction-id', 'x-request-id'] },
      });
      const logger = module.imports?.[0] as {
        providers?: ValueProvider[];
      };
      const params = logger.providers?.find(
        (provider) => provider.provide === 'pino-params',
      )?.useValue as { pinoHttp: { genReqId: (r: unknown) => string } };

      expect(
        params.pinoHttp.genReqId({
          headers: { 'transaction-id': 'tx-1', 'x-request-id': 'r-1' },
        }),
      ).toBe('tx-1');
      expect(
        params.pinoHttp.genReqId({ headers: { 'x-request-id': 'r-1' } }),
      ).toBe('r-1');
    });
  });

  describe('configure', () => {
    // Including the probes: a probe that fails is exactly the log line someone
    // will want to correlate.
    it('applies the middleware to every route', () => {
      const forRoutes = vi.fn();
      const consumer = {
        apply: vi.fn().mockReturnValue({ forRoutes }),
      } as unknown as MiddlewareConsumer;

      new NovaObservabilityModule().configure(consumer);

      expect(consumer.apply).toHaveBeenCalledWith(RequestContextMiddleware);
      expect(forRoutes).toHaveBeenCalledWith('*path');
    });
  });
});
