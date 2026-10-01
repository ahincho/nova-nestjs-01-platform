import { Logger } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { TerminusModule, type HealthCheckResult } from '@nestjs/terminus';
import { Test, type TestingModule } from '@nestjs/testing';
import { SKIP_RESPONSE_WRAPPER } from '../api';
import { IS_PUBLIC } from '../auth';
import {
  createHealthController,
  createLegacyHealthController,
} from './health.controller';
import {
  HEALTH_OPTIONS,
  resolveHealthOptions,
  type NovaHealthModuleOptions,
} from './tokens';
import type { Mock } from 'vitest';

type ResponseDouble = { status: Mock };
type Probes = {
  live(): HealthCheckResult;
  ready(response: ResponseDouble): Promise<HealthCheckResult>;
};
type Legacy = {
  check(response: ResponseDouble): Promise<HealthCheckResult>;
};

const LEGACY_PATH = 'api/v1/health';

async function harness(options: NovaHealthModuleOptions = {}): Promise<{
  probes: Probes;
  legacy: Legacy;
  moduleRef: TestingModule;
  response: ResponseDouble;
}> {
  const resolved = resolveHealthOptions(options);
  const HealthController = createHealthController(resolved.path);
  const LegacyController = createLegacyHealthController(LEGACY_PATH);
  const moduleRef = await Test.createTestingModule({
    imports: [
      TerminusModule.forRoot({
        logger: false,
        gracefulShutdownTimeoutMs: resolved.gracefulShutdownTimeoutMs,
      }),
    ],
    controllers: [HealthController, LegacyController],
    providers: [{ provide: HEALTH_OPTIONS, useValue: resolved }],
  }).compile();
  return {
    probes: moduleRef.get<Probes>(HealthController),
    legacy: moduleRef.get<Legacy>(LegacyController),
    moduleRef,
    response: { status: vi.fn() },
  };
}

const never = (): Promise<boolean> => new Promise(() => undefined);
const after = (ms: number): Promise<boolean> =>
  new Promise((resolve) => setTimeout(() => resolve(true), ms));

describe('the health controller', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Sin esto, activar `auth` dejaria las sondas en 401 y el balanceador
  // desregistraria una tarea que esta perfectamente sana.
  it('stays public when the application turns authentication on', () => {
    expect(Reflect.getMetadata(IS_PUBLIC, createHealthController('h'))).toBe(
      true,
    );
    expect(
      Reflect.getMetadata(IS_PUBLIC, createLegacyHealthController(LEGACY_PATH)),
    ).toBe(true);
  });

  // The load balancer checks the body shape, and the envelope would turn
  // { status: 'ok' } into { data: { status: 'ok' } } while the status stayed
  // 200 - so nothing would reveal the change until a probe started failing.
  it('is exempt from the response envelope', () => {
    expect(
      Reflect.getMetadata(SKIP_RESPONSE_WRAPPER, createHealthController('h')),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        SKIP_RESPONSE_WRAPPER,
        createLegacyHealthController(LEGACY_PATH),
      ),
    ).toBe(true);
  });

  it('mounts the legacy route exactly where it is asked to', () => {
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        createLegacyHealthController(LEGACY_PATH),
      ),
    ).toBe(LEGACY_PATH);
  });

  describe('liveness', () => {
    // A liveness probe that fails because a database is down gets the container
    // restarted, which does not bring the database back.
    it('answers without touching any dependency', async () => {
      const { probes } = await harness({
        readinessChecks: [
          {
            name: 'database',
            check: () => {
              throw new Error('should never be called');
            },
          },
        ],
      });
      expect(probes.live()).toEqual({
        status: 'ok',
        info: {},
        error: {},
        details: {},
      });
    });

    it('stays alive while the service drains', async () => {
      const { probes, moduleRef } = await harness({
        gracefulShutdownTimeoutMs: 50,
      });
      const closing = moduleRef.close();
      expect(probes.live().status).toBe('ok');
      await closing;
    });
  });

  describe('readiness', () => {
    it('is ready with no checks registered', async () => {
      const { probes, response } = await harness();
      await expect(probes.ready(response)).resolves.toEqual({
        status: 'ok',
        info: {},
        error: {},
        details: {},
      });
      expect(response.status).not.toHaveBeenCalled();
    });

    it('reports every check by name in the terminus shape', async () => {
      const { probes, response } = await harness({
        readinessChecks: [
          { name: 'database', check: () => true },
          { name: 'cache', check: () => Promise.resolve(true) },
        ],
      });
      await expect(probes.ready(response)).resolves.toMatchObject({
        status: 'ok',
        info: { database: { status: 'up' }, cache: { status: 'up' } },
        error: {},
        details: { database: { status: 'up' }, cache: { status: 'up' } },
      });
    });

    it('answers 503 when one check fails', async () => {
      const { probes, response } = await harness({
        readinessChecks: [
          { name: 'database', check: () => true },
          { name: 'cache', check: () => false },
        ],
      });
      const result = await probes.ready(response);
      expect(response.status).toHaveBeenCalledWith(503);
      expect(result).toMatchObject({
        status: 'error',
        info: { database: { status: 'up' } },
        error: { cache: { status: 'down', message: 'reported not ready' } },
      });
    });

    it('treats a check that throws as a failure and says why', async () => {
      const { probes, response } = await harness({
        readinessChecks: [
          {
            name: 'queue',
            check: () => {
              throw new Error('connection refused');
            },
          },
        ],
      });
      const result = await probes.ready(response);
      expect(response.status).toHaveBeenCalledWith(503);
      expect(result.error).toMatchObject({
        queue: { status: 'down', message: 'connection refused' },
      });
      // El motivo va como campo: en el mensaje, cada motivo era un mensaje
      // distinto y no había cómo contar las caídas de un chequeo.
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        { readiness: { check: 'queue', message: 'connection refused' } },
        'Readiness check failed',
      );
    });

    it('fails a check that outlives its deadline', async () => {
      const { probes, response } = await harness({
        checkTimeoutMs: 20,
        readinessChecks: [{ name: 'slow', check: never }],
      });
      const result = await probes.ready(response);
      expect(response.status).toHaveBeenCalledWith(503);
      expect(result.error?.['slow']).toMatchObject({
        status: 'down',
        message: 'timeout of 20ms exceeded',
      });
    });

    it('runs the checks concurrently rather than one after another', async () => {
      const { probes, response } = await harness({
        readinessChecks: [
          { name: 'first', check: () => after(60) },
          { name: 'second', check: () => after(60) },
        ],
      });
      const started = Date.now();
      await probes.ready(response);
      expect(Date.now() - started).toBeLessThan(110);
    });

    it('accepts a terminus indicator next to the plain checks', async () => {
      const { probes, response } = await harness({
        readinessChecks: [{ name: 'database', check: () => true }],
        readinessIndicators: [() => ({ memory: { status: 'up' } })],
      });
      await expect(probes.ready(response)).resolves.toMatchObject({
        status: 'ok',
        details: { database: { status: 'up' }, memory: { status: 'up' } },
      });
    });

    // The window in which the balancer learns to stop routing here before the
    // process goes away. It only exists while the graceful timeout runs.
    it('answers 503 with shutting_down while the service drains', async () => {
      const { probes, response, moduleRef } = await harness({
        gracefulShutdownTimeoutMs: 300,
      });
      const closing = moduleRef.close();
      // close() runs the destroy hooks before the shutdown ones, so the flag
      // flips a few ticks after the call: poll until terminus sees it.
      let result = await probes.ready(response);
      for (
        let attempt = 0;
        result.status !== 'shutting_down' && attempt < 50;
        attempt += 1
      ) {
        await after(5);
        result = await probes.ready(response);
      }
      expect(result.status).toBe('shutting_down');
      expect(response.status).toHaveBeenLastCalledWith(503);
      await closing;
    });
  });

  describe('the legacy route', () => {
    it('answers like readiness', async () => {
      const { legacy, response } = await harness({
        readinessChecks: [{ name: 'cache', check: () => false }],
      });
      const result = await legacy.check(response);
      expect(response.status).toHaveBeenCalledWith(503);
      expect(result).toMatchObject({
        status: 'error',
        error: { cache: { status: 'down' } },
      });
    });

    it('is ok when nothing is registered', async () => {
      const { legacy, response } = await harness();
      await expect(legacy.check(response)).resolves.toMatchObject({
        status: 'ok',
      });
      expect(response.status).not.toHaveBeenCalled();
    });
  });
});
