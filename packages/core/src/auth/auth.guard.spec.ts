import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContextService } from '../observability';
import { NovaAuthGuard, type AuthenticatedRequest } from './auth.guard';
import { Public } from './public.decorator';
import {
  normalizeUserId,
  resolveAuthOptions,
  type NovaAuthModuleOptions,
} from './tokens';

/**
 * Cómo se lee un token de Keycloak, declarado como lo haría el perfil de una
 * organización: los defaults del núcleo ya no son los de ningún proveedor.
 */
const keycloak: NovaAuthModuleOptions = {
  rolesClaim: 'realm_access.roles',
  ignoredRoles: ['offline_access', 'uma_authorization'],
  ignoredRolePrefixes: ['default-roles-'],
  normalizeId: normalizeUserId,
};

function token(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${payload}.signature`;
}

const student = token({
  preferred_username: '@U12345',
  realm_access: { roles: ['student'] },
});

class SampleController {
  @Public()
  open(): void {}

  closed(): void {}
}

@Public()
class OpenController {
  anything(): void {}
}

function request(headers: Record<string, string> = {}): AuthenticatedRequest {
  return { headers };
}

function execution(
  target: AuthenticatedRequest,
  handler: () => void = SampleController.prototype.closed,
  controller: unknown = SampleController,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => target }),
    getHandler: () => handler,
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

function guard(
  options: NovaAuthModuleOptions = { preferredRoles: ['student'] },
  context?: RequestContextService,
): NovaAuthGuard {
  return new NovaAuthGuard(
    resolveAuthOptions({ ...keycloak, ...options }),
    new Reflector(),
    context,
  );
}

describe('NovaAuthGuard', () => {
  describe('a protected route', () => {
    it('resolves who is calling onto the request', async () => {
      const target = request({ authorization: `Bearer ${student}` });

      await expect(guard().canActivate(execution(target))).resolves.toBe(true);
      expect(target.user).toEqual({
        id: 'U12345',
        role: 'student',
        claims: expect.any(Object) as object,
      });
    });

    // Express normaliza las cabeceras a minúsculas, pero el guard tipa una
    // petición estructural y no puede darlo por hecho.
    it('reads the header whatever its case', async () => {
      const target = request({ Authorization: `Bearer ${student}` });

      await expect(guard().canActivate(execution(target))).resolves.toBe(true);
      expect(target.user?.id).toBe('U12345');
    });

    it.each([
      ['no authorization header', {}],
      ['another scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
      ['an unreadable token', { authorization: 'Bearer not-a-jwt' }],
      [
        'a token with no identifier',
        {
          authorization: `Bearer ${token({ realm_access: { roles: ['a'] } })}`,
        },
      ],
    ])('is rejected with %s', async (_case, headers) => {
      await expect(
        guard().canActivate(execution(request(headers))),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('a public route', () => {
    it('goes through with no token at all', async () => {
      const target = request();
      const context = execution(target, SampleController.prototype.open);

      await expect(guard().canActivate(context)).resolves.toBe(true);
      expect(target.user).toBeUndefined();
    });

    it('can be declared on the whole controller', async () => {
      const context = execution(
        request(),
        OpenController.prototype.anything,
        OpenController,
      );

      await expect(guard().canActivate(context)).resolves.toBe(true);
    });
  });

  describe('the request context', () => {
    it('carries the identifier towards the upstreams', async () => {
      const context = new RequestContextService();
      const target = request({ authorization: `Bearer ${student}` });

      await context.run(
        { requestId: 'req-1', headers: { 'x-request-id': 'req-1' } },
        async () => {
          await guard(undefined, context).canActivate(execution(target));
          expect(context.headers()).toEqual({
            'x-request-id': 'req-1',
            'x-user-id': 'U12345',
          });
        },
      );
    });

    it('can use another header', async () => {
      const context = new RequestContextService();
      const target = request({ authorization: `Bearer ${student}` });

      await context.run({ requestId: 'req-1', headers: {} }, async () => {
        const custom = guard(
          { preferredRoles: ['student'], userIdHeader: 'x-actor' },
          context,
        );
        await custom.canActivate(execution(target));
        expect(context.headers()['x-actor']).toBe('U12345');
      });
    });

    // El guard sirve solo: sin el módulo de observabilidad sigue autenticando.
    it('is optional', async () => {
      const target = request({ authorization: `Bearer ${student}` });

      await expect(guard().canActivate(execution(target))).resolves.toBe(true);
    });

    it('carries the role too when a header is named for it', async () => {
      const context = new RequestContextService();
      const target = request({ authorization: `Bearer ${student}` });

      await context.run({ requestId: 'req-1', headers: {} }, async () => {
        const withRole = guard(
          {
            preferredRoles: ['student'],
            userIdHeader: 'user-id',
            roleHeader: 'user-role',
          },
          context,
        );
        await withRole.canActivate(execution(target));
        expect(context.headers()).toEqual({
          'user-id': 'U12345',
          'user-role': 'student',
        });
      });
    });

    // Qué capa necesita el rol lo decide cada organización.
    it('keeps the role to itself by default', async () => {
      const context = new RequestContextService();
      const target = request({ authorization: `Bearer ${student}` });

      await context.run({ requestId: 'req-1', headers: {} }, async () => {
        await guard(undefined, context).canActivate(execution(target));
        expect(Object.keys(context.headers())).toEqual(['x-user-id']);
      });
    });
  });

  // La identidad que viaja hacia adentro la escribe sólo la autenticación
  // (ADR-037). Lo que el contexto copió de la petición con esos nombres lo
  // escribió quien llama.
  describe('an identity the caller wrote', () => {
    const forged = {
      'x-request-id': 'req-1',
      'user-id': 'SOMEONE-ELSE',
      'user-role': 'admin',
    };
    const identity = {
      preferredRoles: ['student'],
      userIdHeader: 'user-id',
      roleHeader: 'user-role',
    };

    it('is replaced by the token on a protected route', async () => {
      const context = new RequestContextService();
      const target = request({ authorization: `Bearer ${student}` });

      await context.run({ requestId: 'req-1', headers: forged }, async () => {
        await guard(identity, context).canActivate(execution(target));
        expect(context.headers()).toEqual({
          'x-request-id': 'req-1',
          'user-id': 'U12345',
          'user-role': 'student',
        });
      });
    });

    // Es el caso que fallaba: el guard termina antes en una ruta pública, y lo
    // que mandó el cliente viajaba como si fuera el usuario.
    it('never travels from a public route', async () => {
      const context = new RequestContextService();
      const target = execution(request(), SampleController.prototype.open);

      await context.run({ requestId: 'req-1', headers: forged }, async () => {
        await guard(identity, context).canActivate(target);
        expect(context.headers()).toEqual({ 'x-request-id': 'req-1' });
      });
    });

    it('does not travel after a rejected token either', async () => {
      const context = new RequestContextService();

      await context.run({ requestId: 'req-1', headers: forged }, async () => {
        await expect(
          guard(identity, context).canActivate(execution(request())),
        ).rejects.toThrow(UnauthorizedException);
        expect(context.headers()).toEqual({ 'x-request-id': 'req-1' });
      });
    });

    it('is matched whatever the case of its name', async () => {
      const context = new RequestContextService();
      const target = execution(request(), SampleController.prototype.open);

      await context.run(
        { requestId: 'req-1', headers: { 'X-User-Id': 'SOMEONE-ELSE' } },
        async () => {
          await guard(undefined, context).canActivate(target);
          expect(context.headers()).toEqual({});
        },
      );
    });
  });

  describe('a real signature check', () => {
    it('replaces reading the token as it came', async () => {
      const verify = vi.fn().mockResolvedValue({
        preferred_username: 'ana',
        realm_access: { roles: ['teacher'] },
      });
      const target = request({ authorization: 'Bearer opaque-token' });

      await guard({ verify }).canActivate(execution(target));

      expect(verify).toHaveBeenCalledWith('opaque-token');
      expect(target.user?.id).toBe('ANA');
    });

    // Firma, expiración o emisor: para el llamador todas son lo mismo, y decir
    // cuál falló le regala información a quien esté probando tokens.
    it('turns any failure into a plain 401', async () => {
      const verify = vi.fn().mockRejectedValue(new Error('token expired'));
      const target = request({ authorization: 'Bearer opaque-token' });

      await expect(
        guard({ verify }).canActivate(execution(target)),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
