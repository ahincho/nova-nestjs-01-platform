import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Logger } from '@nestjs/common';
import { HttpClientService } from './http-client.service';
import { resolveNovaHttpOptions } from './tokens';
import { UpstreamException, type UpstreamFailure } from './upstream-failure';

/**
 * La clasificación contra servidores de verdad, con el `fetch` real de undici.
 *
 * Las pruebas unitarias fijan qué tipo le toca a cada código; ésta fija que
 * undici siga lanzando esos códigos. Es la que se rompe primero si una versión
 * mayor los cambia, que es el riesgo que ADR-035 anota.
 *
 * Quedan afuera los fallos que dependen de la red de la máquina -un timeout de
 * conexión, una ruta inalcanzable- y TLS, que pide un certificado.
 */
describe('HttpClientService against real servers', () => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  let client: HttpClientService;

  async function serve(
    onConnection: (socket: Socket) => void,
  ): Promise<string> {
    const server = createServer();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      onConnection(socket);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function handle(
    handler: Parameters<typeof createServer>[1],
  ): Promise<string> {
    const server = createServer(handler);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function failureOf(call: Promise<unknown>): Promise<UpstreamFailure> {
    const error: unknown = await call.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpstreamException);
    return (error as UpstreamException).failure;
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    client = new HttpClientService(
      resolveNovaHttpOptions({ defaultTimeoutMs: 400, pool: false }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  it('reports a closed port as connection_refused', async () => {
    const url = await handle(() => undefined);
    const port = new URL(url).port;
    const last = servers.pop();
    await new Promise<void>((resolve) => last?.close(() => resolve()));

    await expect(
      failureOf(client.get(`http://127.0.0.1:${port}/`)),
    ).resolves.toMatchObject({
      type: 'connection_refused',
      category: 'connectivity',
      code: 'ECONNREFUSED',
    });
  });

  // El 9 es uno de los puertos que el estándar de fetch prohíbe: undici lo
  // rechaza antes de conectar, y es una URL mal configurada.
  it('reports a port that fetch refuses as a configuration error', async () => {
    await expect(
      failureOf(client.get('http://127.0.0.1:9/')),
    ).resolves.toMatchObject({
      type: 'proxy_configuration_error',
      category: 'internal',
      status: 500,
    });
  });

  // `.invalid` es el dominio que RFC 2606 garantiza que nunca resuelve. Según
  // el servidor de nombres de la máquina puede contestar que no existe o no
  // contestar a tiempo, y los dos son conectividad.
  it('reports a name that does not resolve as a DNS failure', async () => {
    const failure = await failureOf(
      client.get('http://nova-no-existe.invalid/'),
    );

    expect(failure.category).toBe('connectivity');
    expect(['dns_error', 'dns_timeout']).toContain(failure.type);
  });

  it('reports a connection closed before the response as terminated', async () => {
    const url = await handle((request) => {
      request.socket.destroy();
    });

    await expect(failureOf(client.get(url))).resolves.toMatchObject({
      type: 'connection_terminated',
      category: 'network',
      code: 'UND_ERR_SOCKET',
    });
  });

  it('reports a body cut halfway as incomplete, not as a 500', async () => {
    const url = await handle((request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '100',
      });
      response.write('{"id":');
      setTimeout(() => request.socket.destroy(), 20);
    });

    await expect(failureOf(client.get(url))).resolves.toMatchObject({
      type: 'http_response_incomplete',
      category: 'network',
      phase: 'body',
      status: 502,
    });
  });

  it('reports an answer that is not HTTP as a protocol error', async () => {
    const url = await serve((socket) => {
      socket.once('data', () => socket.end('HELLO NOT HTTP\r\n\r\n'));
    });

    await expect(failureOf(client.get(url))).resolves.toMatchObject({
      type: 'http_protocol_error',
      category: 'network',
    });
  });

  it('reports an upstream that never answers as its own timeout', async () => {
    const url = await handle(() => undefined);

    await expect(failureOf(client.get(url))).resolves.toMatchObject({
      type: 'http_response_timeout',
      category: 'timeout',
      status: 504,
    });
  });

  it('reports an upstream error status as a response failure', async () => {
    const url = await handle((request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"message":"down"}');
    });

    await expect(failureOf(client.get(url))).resolves.toMatchObject({
      category: 'response',
      receivedStatus: 503,
      status: 502,
    });
  });

  it('reports HTML where JSON was expected as a broken contract', async () => {
    const url = await handle((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>Service Unavailable</html>');
    });

    await expect(failureOf(client.get(url))).resolves.toMatchObject({
      type: 'http_response_content_invalid',
      category: 'contract',
    });
  });
});
