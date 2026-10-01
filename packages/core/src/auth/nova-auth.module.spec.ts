import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { NovaAuthGuard } from './auth.guard';
import { NovaAuthModule } from './nova-auth.module';
import {
  AUTH_OPTIONS,
  DEFAULT_ID_CLAIM,
  DEFAULT_IGNORED_ROLES,
  DEFAULT_IGNORED_ROLE_PREFIXES,
  DEFAULT_ROLES_CLAIM,
  DEFAULT_USER_ID_HEADER,
  normalizeUserId,
  resolveAuthOptions,
  trimUserId,
} from './tokens';

type Provider = { provide?: unknown; useExisting?: unknown };

describe('resolveAuthOptions', () => {
  it('applies the defaults', () => {
    expect(resolveAuthOptions()).toEqual({
      idClaim: DEFAULT_ID_CLAIM,
      normalizeId: trimUserId,
      rolesClaim: DEFAULT_ROLES_CLAIM,
      preferredRoles: [],
      ignoredRoles: DEFAULT_IGNORED_ROLES,
      ignoredRolePrefixes: DEFAULT_IGNORED_ROLE_PREFIXES,
      userIdHeader: DEFAULT_USER_ID_HEADER,
      verify: undefined,
    });
  });

  it('keeps a default when a field is explicitly undefined', () => {
    expect(resolveAuthOptions({ idClaim: undefined }).idClaim).toBe(
      DEFAULT_ID_CLAIM,
    );
  });

  it('takes what the application declares', () => {
    const options = resolveAuthOptions({
      idClaim: 'sub',
      preferredRoles: ['admin'],
      userIdHeader: 'x-actor',
    });
    expect(options).toMatchObject({
      idClaim: 'sub',
      preferredRoles: ['admin'],
      userIdHeader: 'x-actor',
    });
  });
});

// Los defaults son los de los estándares, no los de un proveedor: `roles` de
// RFC 9068 y ningún rol técnico que descartar.
describe('the generic defaults', () => {
  it('read the roles of RFC 9068', () => {
    expect(DEFAULT_ROLES_CLAIM).toBe('roles');
  });

  it('ignore no role of any provider', () => {
    expect(DEFAULT_IGNORED_ROLES).toEqual([]);
    expect(DEFAULT_IGNORED_ROLE_PREFIXES).toEqual([]);
  });

  it('only trim the identifier', () => {
    expect(trimUserId('  @Ana  ')).toBe('@Ana');
  });
});

describe('normalizeUserId', () => {
  it.each([
    ['@u12345', 'U12345'],
    ['  U12345  ', 'U12345'],
    ['ana@utp.edu.pe', 'ANA@UTP.EDU.PE'],
  ])('turns %s into %s', (raw, expected) => {
    expect(normalizeUserId(raw)).toBe(expected);
  });
});

describe('NovaAuthModule.forRoot', () => {
  it('is global, so a feature module does not import it again', () => {
    expect(NovaAuthModule.forRoot().global).toBe(true);
  });

  // El guard tiene que quedar global: registrarlo ruta por ruta es como una
  // ruta nueva nace abierta. Y va por `useExisting`, para que el guard global y
  // el que alguien inyecte a mano sean la misma instancia.
  it('registers the guard for every route', () => {
    const providers = (NovaAuthModule.forRoot().providers ?? []) as Provider[];
    const global = providers.find((provider) => provider.provide === APP_GUARD);

    expect(global?.useExisting).toBe(NovaAuthGuard);
  });

  it('resolves the guard with its options', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NovaAuthModule.forRoot({ preferredRoles: ['student'] })],
    }).compile();

    expect(moduleRef.get(NovaAuthGuard)).toBeInstanceOf(NovaAuthGuard);
    expect(moduleRef.get(AUTH_OPTIONS)).toMatchObject({
      preferredRoles: ['student'],
    });
  });
});
