import { Test } from '@nestjs/testing';
import { API_STANDARD } from './api';
import { NovaEnvelopeStandard } from './api-standard';
import { AUTH_OPTIONS, NovaAuthModule, type ResolvedAuthOptions } from './auth';
import { HEALTH_OPTIONS, type ResolvedHealthOptions } from './health';
import { NOVA_HTTP_OPTIONS, type ResolvedNovaHttpOptions } from './http';
import { NovaModule } from './nova.module';
import { NOVA_PROFILE, defineProfile, mergeOptions } from './profile';

describe('defineProfile', () => {
  it('hands the profile back as it was declared', () => {
    const acme = { name: 'acme', health: { legacyPath: 'api/v1/health' } };

    expect(defineProfile(acme)).toBe(acme);
  });

  // El nombre es lo que `bootstrap()` compara con el del módulo; sin él no hay
  // con qué detectar que recibieron perfiles distintos.
  it('refuses a profile without a name', () => {
    expect(() => defineProfile({ name: '  ' })).toThrow('needs a name');
  });
});

describe('mergeOptions', () => {
  it('lets the service win option by option', () => {
    expect(
      mergeOptions(
        { defaultTimeoutMs: 3000, defaultHeaders: { 'x-org': 'acme' } },
        { defaultTimeoutMs: 1000 },
      ),
    ).toEqual({ defaultTimeoutMs: 1000, defaultHeaders: { 'x-org': 'acme' } });
  });

  // Un `undefined` explícito del servicio no es «sin valor»: si borrara el del
  // perfil, en cada punto de uso se leería como apagado.
  it('never lets an explicit undefined erase the profile', () => {
    expect(
      mergeOptions({ defaultTimeoutMs: 3000 }, { defaultTimeoutMs: undefined }),
    ).toEqual({ defaultTimeoutMs: 3000 });
  });

  it('takes whichever side is the only one declared', () => {
    const only = { defaultTimeoutMs: 3000 };

    expect(mergeOptions(only, undefined)).toBe(only);
    expect(mergeOptions(undefined, only)).toBe(only);
    expect(mergeOptions(undefined, undefined)).toBeUndefined();
  });
});

// Se compila un módulo de verdad: lo que importa no es qué objeto se pasó sino
// con qué opciones terminó cada módulo de la plataforma.
describe('a profile given to NovaModule', () => {
  const standard = new NovaEnvelopeStandard({
    codes: { byStatus: { 502: 'BAD_GATEWAY' } },
  });

  const acme = defineProfile({
    name: 'acme',
    apiStandard: { standard },
    http: { defaultTimeoutMs: 3000, defaultHeaders: { 'x-org': 'acme' } },
    health: { legacyPath: 'api/v1/health' },
    auth: { rolesClaim: 'realm_access.roles' },
  });

  async function compile(options: Parameters<typeof NovaModule.forRoot>[0]) {
    return Test.createTestingModule({
      imports: [NovaModule.forRoot(options)],
    }).compile();
  }

  it('configures every module it declares', async () => {
    const moduleRef = await compile({ profile: acme });

    expect(moduleRef.get(API_STANDARD)).toBe(standard);
    expect(
      moduleRef.get<ResolvedNovaHttpOptions>(NOVA_HTTP_OPTIONS),
    ).toMatchObject({
      defaultTimeoutMs: 3000,
      defaultHeaders: { 'x-org': 'acme' },
    });
    expect(moduleRef.get<ResolvedHealthOptions>(HEALTH_OPTIONS)).toMatchObject({
      legacyPath: 'api/v1/health',
    });
  });

  it('gives way to what the service declares', async () => {
    const moduleRef = await compile({
      profile: acme,
      http: { defaultTimeoutMs: 1000 },
    });

    expect(
      moduleRef.get<ResolvedNovaHttpOptions>(NOVA_HTTP_OPTIONS),
    ).toMatchObject({
      defaultTimeoutMs: 1000,
      defaultHeaders: { 'x-org': 'acme' },
    });
  });

  // El guard es global: si el perfil lo encendiera, todo servicio interno de la
  // organización quedaría en 401.
  it('does not turn authentication on by itself', () => {
    const module = NovaModule.forRoot({ profile: acme });

    expect(
      (module.imports as { module?: unknown }[]).some(
        (imported) => imported.module === NovaAuthModule,
      ),
    ).toBe(false);
  });

  it('says how to read the token once the service asks for it', async () => {
    const moduleRef = await compile({
      profile: acme,
      auth: { preferredRoles: ['student'] },
    });

    expect(moduleRef.get<ResolvedAuthOptions>(AUTH_OPTIONS)).toMatchObject({
      rolesClaim: 'realm_access.roles',
      preferredRoles: ['student'],
    });
  });

  it('registers its name for bootstrap() to compare', async () => {
    expect((await compile({ profile: acme })).get(NOVA_PROFILE)).toBe('acme');
    expect((await compile({})).get(NOVA_PROFILE)).toBeNull();
  });
});
