import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Agent, type Dispatcher } from 'undici';
import { NOVA_HTTP_OPTIONS, type ResolvedNovaHttpOptions } from './tokens';

/**
 * Custodia el pool de conexiones que comparten todas las llamadas salientes.
 *
 * **Uno solo y no uno por upstream.** Un pool por upstream multiplica la
 * configuración y las métricas por la cantidad de upstreams, y lo que se quiere
 * mirar -cuántas conexiones tiene vivas este contenedor- deja de ser un número.
 * El upstream que de verdad necesita el suyo -otro TLS, un pinning- lo pasa por
 * llamada como `dispatcher`, que ya es una opción del cliente.
 *
 * El cierre ordenado importa tanto como el pool: si el proceso se va con
 * sockets vivos, los upstreams ven un RST y la traza se corta del otro lado.
 */
@Injectable()
export class NovaHttpAgent implements OnModuleDestroy {
  private readonly logger = new Logger(NovaHttpAgent.name);
  private readonly agent: Agent | undefined;

  constructor(
    @Inject(NOVA_HTTP_OPTIONS)
    private readonly options: ResolvedNovaHttpOptions,
  ) {
    const pool = this.options.pool;

    this.agent =
      pool === false
        ? undefined
        : new Agent({
            connections: pool.connections,
            pipelining: pool.pipelining,
            keepAliveTimeout: pool.keepAliveTimeoutMs,
            // Los plazos de cabeceras y de cuerpo NO se fijan acá: el cliente
            // pone un `AbortSignal.timeout` por llamada, y un plazo del pool
            // pisaría el que cada upstream declara para sí.
          });
  }

  /**
   * El despachador compartido, o `undefined` cuando el pool está apagado -- que
   * es lo que el cliente pasa a `fetch` para caer en el global de undici.
   */
  dispatcher(): Dispatcher | undefined {
    return this.agent;
  }

  /**
   * Espera a que terminen las llamadas en vuelo, con un tope.
   *
   * El tope existe porque `close()` no vuelve mientras quede una petición
   * abierta: un upstream que dejó de contestar y no cortó el socket bloquearía
   * el apagado hasta que ECS mande el SIGKILL, y ahí se pierde todo lo que el
   * apagado ordenado iba a salvar.
   */
  async onModuleDestroy(): Promise<void> {
    const pool = this.options.pool;
    if (!this.agent || pool === false) {
      return;
    }

    const closed = await Promise.race([
      this.agent.close().then(() => true),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), pool.closeTimeoutMs).unref(),
      ),
    ]);

    if (!closed) {
      this.logger.warn(
        `Connections were still open after ${pool.closeTimeoutMs}ms; destroying the pool`,
      );
      await this.agent.destroy();
    }
  }
}
