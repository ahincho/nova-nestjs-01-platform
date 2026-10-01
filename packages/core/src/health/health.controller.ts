import {
  Controller,
  Get,
  Inject,
  Logger,
  Res,
  ServiceUnavailableException,
  type Type,
} from '@nestjs/common';
import {
  HealthCheckService,
  HealthIndicatorService,
  type HealthCheckResult,
  type HealthIndicatorFunction,
} from '@nestjs/terminus';
import { SkipResponseWrapper } from '../api';
import { Public } from '../auth/public.decorator';
import {
  HEALTH_OPTIONS,
  type ReadinessCheck,
  type ResolvedHealthOptions,
} from './tokens';

type ResponseLike = {
  status(code: number): unknown;
};

/**
 * Corre los indicadores con terminus y convierte su resultado en una respuesta
 * HTTP. Compartido por las sondas que dependen de chequeos.
 */
async function answer(
  health: HealthCheckService,
  response: ResponseLike,
  indicators: HealthIndicatorFunction[],
): Promise<HealthCheckResult> {
  try {
    return await health.check(indicators);
  } catch (cause) {
    if (!(cause instanceof ServiceUnavailableException)) {
      throw cause;
    }
    // terminus reporta un fallo lanzando; acá se vuelve un 503 con el mismo
    // cuerpo. Dejar pasar la excepción la mandaría por el filtro global, que la
    // devolvería envuelta en el sobre estándar, y el contrato de la sonda es la
    // forma del cuerpo tanto como el código.
    response.status(503);
    return cause.getResponse() as HealthCheckResult;
  }
}

/**
 * Un `ReadinessCheck` como indicador de terminus: la fecha límite la pone
 * `withTimeout`, y devolver `false` cuenta igual que lanzar.
 */
function adapt(
  indicators: HealthIndicatorService,
  check: ReadinessCheck,
  timeoutMs: number,
): HealthIndicatorFunction {
  return () =>
    indicators
      .check(check.name)
      .attempt(async () => {
        if (!(await check.check())) {
          throw new Error('reported not ready');
        }
      })
      .withTimeout(timeoutMs);
}

function readinessIndicators(
  indicators: HealthIndicatorService,
  options: ResolvedHealthOptions,
): HealthIndicatorFunction[] {
  return [
    ...options.readinessChecks.map((check) =>
      adapt(indicators, check, options.checkTimeoutMs),
    ),
    ...options.readinessIndicators,
  ];
}

/**
 * En warn y no en error: una dependencia que parpadea tiene que verse sin que
 * cada ciclo de la sonda parezca una caída.
 *
 * El chequeo y su motivo van como campos: pegados al mensaje, cada motivo
 * distinto era un mensaje distinto, y no había cómo contar las caídas de un
 * chequeo sin parsear texto.
 */
function warnAboutFailures(logger: Logger, result: HealthCheckResult): void {
  for (const [name, detail] of Object.entries(result.error ?? {})) {
    const message =
      typeof detail?.['message'] === 'string' ? detail['message'] : 'down';
    logger.warn(
      { readiness: { check: name, message } },
      'Readiness check failed',
    );
  }
}

/**
 * Construye el controlador de sondas bajo la ruta configurada.
 *
 * Una fábrica y no una clase suelta porque `@Controller(path)` fija la ruta al
 * decorar, y la ruta tiene que salir de las opciones del módulo.
 */
export function createHealthController(path: string): Type<unknown> {
  // `@Public()` sólo hace algo si la aplicación activó `auth`, y ahí es
  // indispensable: una sonda que responde 401 desregistra una tarea sana.
  @Public()
  @SkipResponseWrapper()
  @Controller(path)
  class HealthController {
    private readonly logger = new Logger('Health');

    constructor(
      @Inject(HEALTH_OPTIONS)
      private readonly options: ResolvedHealthOptions,
      private readonly health: HealthCheckService,
      private readonly indicators: HealthIndicatorService,
    ) {}

    /**
     * Si el proceso está vivo. A propósito no toca ninguna dependencia ni pasa
     * por terminus: una sonda de vida que falla porque la base de datos está
     * caída consigue que reinicien el contenedor, y eso no levanta la base de
     * datos. Tampoco cae durante el apagado ordenado: en esa ventana el proceso
     * sigue vivo, solo dejó de aceptar tráfico nuevo.
     */
    @Get('live')
    live(): HealthCheckResult {
      return { status: 'ok', info: {}, error: {}, details: {} };
    }

    /**
     * Si el servicio puede recibir tráfico: todos los chequeos arriba y sin un
     * apagado en curso. Cualquier otra cosa es 503.
     */
    @Get('ready')
    async ready(
      @Res({ passthrough: true }) response: ResponseLike,
    ): Promise<HealthCheckResult> {
      const result = await answer(
        this.health,
        response,
        readinessIndicators(this.indicators, this.options),
      );
      warnAboutFailures(this.logger, result);
      return result;
    }
  }

  return HealthController;
}

/**
 * La ruta que un target group ya existente revisa, por ejemplo
 * `/api/v1/health`. Responde como `ready`: es la que decide si llega tráfico,
 * así que cae con los chequeos y durante el apagado.
 */
export function createLegacyHealthController(path: string): Type<unknown> {
  @Public()
  @SkipResponseWrapper()
  @Controller(path)
  class LegacyHealthController {
    private readonly logger = new Logger('Health');

    constructor(
      @Inject(HEALTH_OPTIONS)
      private readonly options: ResolvedHealthOptions,
      private readonly health: HealthCheckService,
      private readonly indicators: HealthIndicatorService,
    ) {}

    @Get()
    async check(
      @Res({ passthrough: true }) response: ResponseLike,
    ): Promise<HealthCheckResult> {
      const result = await answer(
        this.health,
        response,
        readinessIndicators(this.indicators, this.options),
      );
      warnAboutFailures(this.logger, result);
      return result;
    }
  }

  return LegacyHealthController;
}
