import { UnauthorizedException } from '@nestjs/common';
import { resolvePrincipal } from './principal';
import {
  normalizeUserId,
  resolveAuthOptions,
  type NovaAuthModuleOptions,
} from './tokens';

/**
 * Cómo se lee un token de Keycloak, declarado como lo haría el perfil de una
 * organización. La mayoría de estas pruebas usa esta forma porque cubre todos
 * los caminos de la resolución: claim anidado, roles técnicos, normalización.
 */
const keycloak: NovaAuthModuleOptions = {
  rolesClaim: 'realm_access.roles',
  ignoredRoles: ['offline_access', 'uma_authorization'],
  ignoredRolePrefixes: ['default-roles-'],
  normalizeId: normalizeUserId,
};

const options = resolveAuthOptions({
  ...keycloak,
  preferredRoles: ['student'],
});

function claims(overrides: Record<string, unknown> = {}) {
  return {
    preferred_username: '@U12345',
    realm_access: { roles: ['student'] },
    ...overrides,
  };
}

describe('resolvePrincipal', () => {
  describe('the identifier', () => {
    it('comes from the configured claim, normalised', () => {
      expect(resolvePrincipal(claims(), options).id).toBe('U12345');
    });

    it('loses the leading at sign and the surrounding spaces', () => {
      const principal = resolvePrincipal(
        claims({ preferred_username: '  @u12345  ' }),
        options,
      );
      expect(principal.id).toBe('U12345');
    });

    // Un correo no es un código de usuario, pero si el emisor manda eso, la
    // arroba del medio se queda: recortarla inventaría un identificador.
    it('keeps an at sign that is not the first character', () => {
      const principal = resolvePrincipal(
        claims({ preferred_username: 'ana@example.edu' }),
        options,
      );
      expect(principal.id).toBe('ANA@EXAMPLE.EDU');
    });

    it('can be normalised by the application', () => {
      const lowercase = resolveAuthOptions({
        ...keycloak,
        normalizeId: (raw) => raw.toLowerCase(),
      });
      expect(resolvePrincipal(claims(), lowercase).id).toBe('@u12345');
    });

    it.each([
      ['the claim is missing', { preferred_username: undefined }],
      ['the claim is not a string', { preferred_username: 42 }],
      ['the claim is blank', { preferred_username: '   ' }],
      ['the claim is only an at sign', { preferred_username: '@' }],
    ])('is rejected when %s', (_case, overrides) => {
      expect(() => resolvePrincipal(claims(overrides), options)).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('the role', () => {
    it('is the preferred one wherever it appears in the list', () => {
      const principal = resolvePrincipal(
        claims({ realm_access: { roles: ['teacher', 'student'] } }),
        options,
      );
      expect(principal.role).toBe('student');
    });

    // Se devuelve el valor configurado y no el del token: la aplicación
    // compara contra una cadena estable.
    it('is spelled as configured, not as the issuer wrote it', () => {
      const principal = resolvePrincipal(
        claims({ realm_access: { roles: ['STUDENT'] } }),
        options,
      );
      expect(principal.role).toBe('student');
    });

    it('falls back to the first usable role', () => {
      const principal = resolvePrincipal(
        claims({ realm_access: { roles: ['coordinator', 'teacher'] } }),
        options,
      );
      expect(principal.role).toBe('coordinator');
    });

    // Estos describen lo que el token puede hacer, no quién lo trae.
    it('ignores the technical roles of the issuer', () => {
      const principal = resolvePrincipal(
        claims({
          realm_access: {
            roles: [
              'offline_access',
              'uma_authorization',
              'default-roles-nova',
              'teacher',
            ],
          },
        }),
        options,
      );
      expect(principal.role).toBe('teacher');
    });

    it('ignores a blank entry', () => {
      const principal = resolvePrincipal(
        claims({ realm_access: { roles: ['   ', 'teacher'] } }),
        options,
      );
      expect(principal.role).toBe('teacher');
    });

    it('ignores entries that are not strings', () => {
      const principal = resolvePrincipal(
        claims({ realm_access: { roles: [null, 7, 'teacher'] } }),
        options,
      );
      expect(principal.role).toBe('teacher');
    });

    it.each([
      ['the claim is missing', { realm_access: undefined }],
      ['the claim is not an array', { realm_access: { roles: 'student' } }],
      ['the list is empty', { realm_access: { roles: [] } }],
      [
        'every role is a technical one',
        { realm_access: { roles: ['offline_access', 'default-roles-nova'] } },
      ],
    ])('is rejected when %s', (_case, overrides) => {
      expect(() => resolvePrincipal(claims(overrides), options)).toThrow(
        UnauthorizedException,
      );
    });
  });

  // Sin perfil, lo que se lee es lo que dicen los estándares y nada de un
  // proveedor: `preferred_username` de OpenID Connect y `roles` de RFC 9068.
  describe('with the generic defaults', () => {
    const generic = resolveAuthOptions();

    it('reads the roles of RFC 9068', () => {
      const principal = resolvePrincipal(
        { preferred_username: 'ana', roles: ['admin'] },
        generic,
      );
      expect(principal.role).toBe('admin');
    });

    // Cualquier otra transformación sería inventar la convención de alguien.
    it('keeps the identifier as the issuer wrote it, trimmed', () => {
      const principal = resolvePrincipal(
        { preferred_username: '  @Ana  ', roles: ['admin'] },
        generic,
      );
      expect(principal.id).toBe('@Ana');
    });

    it('does not know the technical roles of any provider', () => {
      const principal = resolvePrincipal(
        { preferred_username: 'ana', roles: ['offline_access', 'admin'] },
        generic,
      );
      expect(principal.role).toBe('offline_access');
    });

    // Un token de Keycloak sin su perfil no tiene roles donde se buscan, y eso
    // es un 401, no un usuario sin rol.
    it('rejects a Keycloak token without the profile that reads it', () => {
      expect(() => resolvePrincipal(claims(), generic)).toThrow(
        UnauthorizedException,
      );
    });
  });

  it('keeps the whole payload for whatever the application needs', () => {
    const principal = resolvePrincipal(claims({ campus: 'lima' }), options);
    expect(principal.claims['campus']).toBe('lima');
  });

  it('cannot be modified once resolved', () => {
    const principal = resolvePrincipal(claims(), options);
    expect(Object.isFrozen(principal)).toBe(true);
  });
});
