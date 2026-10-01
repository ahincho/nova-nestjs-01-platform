import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { bootstrap } from './bootstrap';
import {
  OBSERVABILITY_OPTIONS,
  resolveObservabilityOptions,
} from './observability';
import { setupOpenApi } from './openapi';
import { NOVA_PROFILE, defineProfile } from './profile';
import type { Mock } from 'vitest';

// El montaje se sustituye porque necesita una aplicación de verdad para
// recorrer los controladores, y acá el doble es un objeto plano. Lo que se
// prueba en este archivo es *cuándo* se llama; el qué monta lo prueban los
// tests de `openapi/`.
vi.mock('./openapi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openapi')>()),
  setupOpenApi: vi.fn(),
}));

type AppDouble = {
  useLogger: Mock;
  useGlobalPipes: Mock;
  setGlobalPrefix: Mock;
  enableCors: Mock;
  enableShutdownHooks: Mock;
  listen: Mock;
  close: Mock;
  get: Mock;
};

const PORT_VARIABLES = ['APP_PORT', 'PORT', 'HTTP_PORT'];
const SECRET_VARIABLES = ['SECRET_DB', 'NOVA_SECRETS', 'DB_HOST'];

function clearEnvironment(): void {
  for (const name of [...PORT_VARIABLES, ...SECRET_VARIABLES]) {
    delete process.env[name];
  }
}

describe('bootstrap', () => {
  let app: AppDouble;

  beforeEach(() => {
    app = {
      useLogger: vi.fn(),
      useGlobalPipes: vi.fn(),
      setGlobalPrefix: vi.fn(),
      enableCors: vi.fn(),
      enableShutdownHooks: vi.fn(),
      listen: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      // Por defecto no hay nada que resolver: es el servicio que apagó el
      // logger de la plataforma, y ahí queda el de Nest.
      get: vi.fn().mockImplementation(() => {
        throw new Error('not registered');
      }),
    };

    vi.spyOn(NestFactory, 'create').mockResolvedValue(
      app as unknown as INestApplication,
    );
    clearEnvironment();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearEnvironment();
  });

  class AppModule {}

  // Binding to localhost inside a container makes the service unreachable from
  // the load balancer while looking perfectly healthy from a local shell.
  it('binds every interface on port 3000 by default', async () => {
    await bootstrap(AppModule);

    expect(app.listen).toHaveBeenCalledWith(3000, '0.0.0.0');
  });

  it('reads the port from the environment', async () => {
    process.env['PORT'] = '8080';

    await bootstrap(AppModule);

    expect(app.listen).toHaveBeenCalledWith(8080, '0.0.0.0');
  });

  it('lets the caller pass the port and host explicitly', async () => {
    await bootstrap(AppModule, { port: 4000, host: '127.0.0.1' });

    expect(app.listen).toHaveBeenCalledWith(4000, '127.0.0.1');
  });

  it('installs the validation pipe with the envelope factory', async () => {
    await bootstrap(AppModule);

    const pipe = app.useGlobalPipes.mock.calls[0]?.[0] as ValidationPipe;
    expect(pipe).toBeInstanceOf(ValidationPipe);
  });

  it('leaves CORS off unless a policy is given', async () => {
    await bootstrap(AppModule);
    expect(app.enableCors).not.toHaveBeenCalled();

    await bootstrap(AppModule, {
      cors: { origins: 'https://nova.example.edu' },
    });
    expect(app.enableCors).toHaveBeenCalledWith(
      expect.objectContaining({ origin: ['https://nova.example.edu'] }),
    );
  });

  // CORS permite justo las cabeceras que el contexto lee, porque las toma del
  // mismo lugar: declararlas dos veces es cómo un borde acepta una cabecera que
  // el navegador no puede mandar (ADR-037).
  it('lets the browser send and read the request id the edge uses', async () => {
    app.get.mockImplementation((token: unknown) => {
      if (token === OBSERVABILITY_OPTIONS) {
        return resolveObservabilityOptions({
          requestId: { accept: ['transaction-id', 'x-request-id'] },
        });
      }
      throw new Error('not registered');
    });

    await bootstrap(AppModule, {
      cors: { origins: 'https://nova.example.edu' },
    });

    expect(app.enableCors).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedHeaders: expect.arrayContaining([
          'transaction-id',
          'x-request-id',
        ]) as string[],
        exposedHeaders: ['transaction-id'],
      }),
    );
  });

  it('adds no global prefix unless asked', async () => {
    await bootstrap(AppModule);

    expect(app.setGlobalPrefix).not.toHaveBeenCalled();
  });

  // A prefix that quietly moves /health/live to /api/health/live makes the task
  // deregister seconds after it registers, and the deploy dies ten minutes
  // later on a timeout that reads like a resource problem.
  it('keeps the probes out of the global prefix', async () => {
    await bootstrap(AppModule, { globalPrefix: 'api' });

    expect(app.setGlobalPrefix).toHaveBeenCalledWith('api', {
      exclude: ['health/live', 'health/ready'],
    });
  });

  it('excludes the probes under a custom health path', async () => {
    await bootstrap(AppModule, { globalPrefix: 'api', healthPath: 'status' });

    expect(app.setGlobalPrefix).toHaveBeenCalledWith('api', {
      exclude: ['status/live', 'status/ready'],
    });
  });

  it('keeps the legacy health route out of the global prefix', async () => {
    await bootstrap(AppModule, {
      globalPrefix: 'api',
      legacyHealthPath: 'api/v1/health',
    });

    expect(app.setGlobalPrefix).toHaveBeenCalledWith('api', {
      exclude: ['health/live', 'health/ready', 'api/v1/health'],
    });
  });

  // Without the hooks SIGTERM kills the process before any module hears about
  // it, and the graceful window of the readiness probe never opens.
  it('enables the shutdown hooks', async () => {
    await bootstrap(AppModule);

    expect(app.enableShutdownHooks).toHaveBeenCalled();
  });

  it('installs a logger when one is given', async () => {
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

    await bootstrap(AppModule, { logger });

    expect(app.useLogger).toHaveBeenCalledWith(logger);
  });

  // El logger estructurado se resuelve del contenedor en vez de construirse
  // acá, para que sea el mismo que inyectan los servicios: dos instancias son
  // dos configuraciones que se pueden separar sin que nadie lo note.
  it('installs the platform logger when no other is given', async () => {
    const platform = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
    // Como en una aplicación de verdad: el módulo registra su perfil -ninguno-
    // y el logger, cada uno bajo su token.
    app.get.mockImplementation((token: unknown) =>
      token === NOVA_PROFILE ? null : platform,
    );

    await bootstrap(AppModule);

    expect(app.useLogger).toHaveBeenCalledWith(platform);
  });

  it('leaves the Nest logger alone when the platform mounted none', async () => {
    await bootstrap(AppModule);

    expect(app.useLogger).not.toHaveBeenCalled();
  });

  describe('the port', () => {
    // PORT es la convención de Node. Otra variable -la que inyecta la
    // plataforma de una organización- la declara su perfil.
    it('reads only PORT by default', async () => {
      process.env['APP_PORT'] = '8080';
      process.env['PORT'] = '3000';

      await bootstrap(AppModule);

      expect(app.listen).toHaveBeenCalledWith(3000, '0.0.0.0');
    });

    it('reads the variables the profile declares, in order', async () => {
      process.env['APP_PORT'] = '8080';
      process.env['PORT'] = '3000';
      const acme = defineProfile({
        name: 'acme',
        bootstrap: { portVariables: ['APP_PORT', 'PORT'] },
      });

      await bootstrap(AppModule, { profile: acme });

      expect(app.listen).toHaveBeenCalledWith(8080, '0.0.0.0');
    });

    it('skips a variable that was left blank', async () => {
      process.env['APP_PORT'] = '   ';
      process.env['PORT'] = '4002';

      await bootstrap(AppModule, { portVariables: ['APP_PORT', 'PORT'] });

      expect(app.listen).toHaveBeenCalledWith(4002, '0.0.0.0');
    });

    it('lets a service name its own variables', async () => {
      process.env['HTTP_PORT'] = '9000';
      process.env['APP_PORT'] = '8080';

      await bootstrap(AppModule, { portVariables: ['HTTP_PORT'] });

      expect(app.listen).toHaveBeenCalledWith(9000, '0.0.0.0');
    });

    // Nombrar la que se encontró y no la lista entera es lo que hace el mensaje
    // accionable.
    it('dies naming the variable that is not a number', async () => {
      process.env['PORT'] = 'eight thousand';

      await expect(bootstrap(AppModule)).rejects.toThrow('PORT');
    });
  });

  describe('the injected secrets', () => {
    it('does nothing unless the service asks', async () => {
      process.env['SECRET_DB'] = JSON.stringify({ DB_HOST: 'academic' });

      await bootstrap(AppModule);

      expect(process.env['DB_HOST']).toBeUndefined();
    });

    // Antes de crear la aplicación, no después: cada registerAs valida sus
    // variables al instanciarse el módulo.
    it('unfolds before the application exists', async () => {
      process.env['SECRET_DB'] = JSON.stringify({ DB_HOST: 'academic' });
      let hostWhenCreated: string | undefined;
      vi.mocked(NestFactory.create).mockImplementation(() => {
        hostWhenCreated = process.env['DB_HOST'];
        return Promise.resolve(app as unknown as INestApplication);
      });

      await bootstrap(AppModule, { secrets: { prefix: 'SECRET_' } });

      expect(hostWhenCreated).toBe('academic');
    });

    it('takes the options straight through', async () => {
      process.env['SECRET_DB'] = JSON.stringify({ DB_HOST: 'academic' });

      await bootstrap(AppModule, { secrets: { prefix: false } });

      expect(process.env['DB_HOST']).toBeUndefined();
    });

    it('stops the boot on a malformed secret', async () => {
      process.env['SECRET_DB'] = 'not json';

      await expect(
        bootstrap(AppModule, { secrets: { prefix: 'SECRET_' } }),
      ).rejects.toThrow('SECRET_DB');
    });

    // Sin perfil no hay prefijo que adivinar: `true` sólo desdobla lo que se
    // nombra en tiempo de ejecución.
    it('reads only NOVA_SECRETS when told true without a profile', async () => {
      process.env['SECRET_DB'] = JSON.stringify({ DB_HOST: 'academic' });

      await bootstrap(AppModule, { secrets: true });
      expect(process.env['DB_HOST']).toBeUndefined();

      process.env['NOVA_SECRETS'] = 'SECRET_DB';
      await bootstrap(AppModule, { secrets: true });
      expect(process.env['DB_HOST']).toBe('academic');
    });

    describe('with a profile', () => {
      const acme = defineProfile({
        name: 'acme',
        bootstrap: { secrets: { prefix: 'SECRET_' } },
      });

      it('unfolds by the convention of the profile', async () => {
        process.env['SECRET_DB'] = JSON.stringify({ DB_HOST: 'academic' });

        await bootstrap(AppModule, { profile: acme });

        expect(process.env['DB_HOST']).toBe('academic');
      });

      it('lets the service turn it off', async () => {
        process.env['SECRET_DB'] = JSON.stringify({ DB_HOST: 'academic' });

        await bootstrap(AppModule, { profile: acme, secrets: false });

        expect(process.env['DB_HOST']).toBeUndefined();
      });

      it('lets the service add to the convention', async () => {
        process.env['LEGACY_CREDENTIALS'] = JSON.stringify({ DB_HOST: 'erp' });

        await bootstrap(AppModule, {
          profile: acme,
          secrets: { variables: ['LEGACY_CREDENTIALS'] },
        });

        expect(process.env['DB_HOST']).toBe('erp');
        delete process.env['LEGACY_CREDENTIALS'];
      });
    });
  });

  describe('a profile', () => {
    const acme = defineProfile({
      name: 'acme',
      bootstrap: { globalPrefix: 'api/v1' },
      health: { legacyPath: 'api/v1/health' },
    });

    beforeEach(() => {
      app.get.mockImplementation((token: unknown) => {
        if (token === NOVA_PROFILE) {
          return 'acme';
        }
        throw new Error('not registered');
      });
    });

    it('brings its prefix and keeps its legacy probe out of it', async () => {
      await bootstrap(AppModule, { profile: acme });

      expect(app.setGlobalPrefix).toHaveBeenCalledWith('api/v1', {
        exclude: ['health/live', 'health/ready', 'api/v1/health'],
      });
    });

    it('gives way to what the service declares', async () => {
      await bootstrap(AppModule, { profile: acme, globalPrefix: 'api/v2' });

      expect(app.setGlobalPrefix).toHaveBeenCalledWith(
        'api/v2',
        expect.anything(),
      );
    });

    // Declarado en dos lugares, el olvido de uno se ve al arrancar y no como
    // una configuración mitad de cada perfil.
    it('stops the boot when the module received another one', async () => {
      await expect(bootstrap(AppModule)).rejects.toThrow(
        'NovaModule.forRoot() received the profile acme but bootstrap() received none',
      );
      expect(app.close).toHaveBeenCalled();
      expect(app.listen).not.toHaveBeenCalled();
    });

    it('is not compared when the application does not use NovaModule', async () => {
      app.get.mockImplementation(() => {
        throw new Error('not registered');
      });

      await expect(bootstrap(AppModule, { profile: acme })).resolves.toBe(app);
    });
  });

  it('buffers the logs until the logger is installed', async () => {
    await bootstrap(AppModule);

    expect(NestFactory.create).toHaveBeenCalledWith(
      AppModule,
      expect.objectContaining({ bufferLogs: true }),
    );
  });

  // A duplicate route is always a bug: one of the two handlers is dead code
  // and which one wins depends on registration order. A shadowed route is
  // sometimes deliberate, so it only warns.
  it('fails on a duplicate route and warns on a shadowed one', async () => {
    await bootstrap(AppModule);

    expect(NestFactory.create).toHaveBeenCalledWith(
      AppModule,
      expect.objectContaining({
        routeConflictPolicy: { duplicate: 'error', shadow: 'warn' },
      }),
    );
  });

  it('lets the caller relax the route conflict policy', async () => {
    await bootstrap(AppModule, { routeConflicts: { duplicate: 'warn' } });

    expect(NestFactory.create).toHaveBeenCalledWith(
      AppModule,
      expect.objectContaining({
        routeConflictPolicy: { duplicate: 'warn' },
      }),
    );
  });

  // The half of the graceful shutdown the hooks do not cover: while the app is
  // closing, a new request has to be turned away with a 503 so the load
  // balancer takes the task out of rotation, and the in-flight ones finish.
  describe('the OpenAPI document', () => {
    beforeEach(() => {
      vi.mocked(setupOpenApi).mockClear();
    });

    // Igual que CORS y que auth: exponer la documentación es una decisión de
    // quien despliega, no un default de la plataforma.
    it('is not published unless asked', async () => {
      await bootstrap(AppModule);

      expect(setupOpenApi).not.toHaveBeenCalled();
    });

    it('is published when the options are given', async () => {
      await bootstrap(AppModule, { openapi: { title: 'Academic ACL' } });

      expect(setupOpenApi).toHaveBeenCalledWith(app, {
        title: 'Academic ACL',
      });
    });

    // `enabled` existe para decidirlo por ambiente sin sacar el bloque, que es
    // lo que deja el título y los tags escritos donde se leen.
    it('can be switched off without removing the options', async () => {
      await bootstrap(AppModule, {
        openapi: { title: 'Academic ACL', enabled: false },
      });

      expect(setupOpenApi).not.toHaveBeenCalled();
    });
  });

  it('answers 503 to new requests while closing', async () => {
    await bootstrap(AppModule);

    expect(NestFactory.create).toHaveBeenCalledWith(
      AppModule,
      expect.objectContaining({ return503OnClosing: true }),
    );
  });
});
