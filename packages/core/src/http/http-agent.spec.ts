import { Logger } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { fetch } from 'undici';
import { NovaHttpAgent } from './http-agent';
import { resolveNovaHttpOptions } from './tokens';

function agentWith(
  options: Parameters<typeof resolveNovaHttpOptions>[0],
): NovaHttpAgent {
  return new NovaHttpAgent(resolveNovaHttpOptions(options));
}

describe('NovaHttpAgent', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has no dispatcher when the pool is off', () => {
    expect(agentWith({ pool: false }).dispatcher()).toBeUndefined();
  });

  it('builds a dispatcher when the pool is on', () => {
    const agent = agentWith({});

    expect(agent.dispatcher()).toBeDefined();

    return agent.onModuleDestroy();
  });

  it('closes without complaining when there is no pool', async () => {
    await expect(agentWith({ pool: false }).onModuleDestroy()).resolves.toBe(
      undefined,
    );
  });

  describe('against a real server', () => {
    let server: Server;
    let url: string;
    let sockets: Set<unknown>;

    beforeEach(async () => {
      sockets = new Set();
      server = createServer((request, response) => {
        sockets.add(request.socket);
        response.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
    });

    afterEach(() => {
      server.closeAllConnections();
      server.close();
    });

    async function burst(dispatcher: unknown, calls = 12): Promise<void> {
      await Promise.all(
        Array.from({ length: calls }, async () => {
          const response = await fetch(url, { dispatcher } as never);
          await response.text();
        }),
      );
    }

    // La razón de ser del pool. Sin él cada llamada abre y cierra un socket: a
    // doce concurrentes son doce handshakes TCP contra el mismo upstream.
    it('keeps the open connections under the configured ceiling', async () => {
      const agent = agentWith({ pool: { connections: 2 } });

      await burst(agent.dispatcher());

      expect(sockets.size).toBe(2);

      await agent.onModuleDestroy();
    });

    it('opens one socket per call with no pool', async () => {
      await burst(undefined);

      expect(sockets.size).toBe(12);
    });

    it('closes the pool on shutdown', async () => {
      const agent = agentWith({ pool: { connections: 2 } });
      await burst(agent.dispatcher());

      await agent.onModuleDestroy();

      // Cerrado quiere decir cerrado: una llamada posterior sobre el mismo
      // despachador ya no sale.
      await expect(burst(agent.dispatcher(), 1)).rejects.toThrow();
    });
  });
});
