---
'@ahincho/nova-nestjs': minor
'@ahincho/nova-nestjs-schematics': minor
'@ahincho/nova-nestjs-toolchain': minor
---

Perfiles de organización, y defaults que ya no son de nadie en particular

Varios defaults del núcleo eran las convenciones de una organización: el puerto
que salía primero de `APP_PORT`, los roles de `realm_access.roles`, el
identificador en mayúsculas, el prefijo `SECRET_`. Para cualquier otra eran
defaults equivocados que había que deshacer servicio por servicio. Es ADR-036.

**Un perfil declara las convenciones de una organización una sola vez**, en su
propio paquete:

```ts
export const acme = defineProfile({
  name: 'acme',
  bootstrap: {
    portVariables: ['APP_PORT', 'PORT'],
    secrets: { prefix: 'SECRET_' },
  },
  auth: { rolesClaim: 'realm_access.roles' },
});

NovaModule.forRoot({ profile: acme });
void bootstrap(AppModule, { profile: acme });
```

El orden es fijo -defaults de Nova, perfil, servicio- y el servicio sigue
pudiendo cambiar cualquier cosa. Un perfil no enciende la autenticación ni toca
una regla del núcleo. Si `NovaModule` y `bootstrap()` reciben perfiles
distintos, el arranque corta.

**Cambios incompatibles**, que un servicio recupera declarando esos valores en
su perfil:

- El puerto sale de `PORT`. `APP_PORT` ya no se lee sin que alguien la declare.
- `secrets` no trae prefijo: `true` sin perfil sólo lee `NOVA_SECRETS`.
  `DEFAULT_SECRET_PREFIX` deja de existir.
- Los roles salen de `roles`, el claim de RFC 9068, y no se descarta ningún rol
  técnico. Un token de Keycloak necesita `rolesClaim: 'realm_access.roles'`.
- El identificador del usuario sólo pierde los espacios de los bordes.
  `normalizeUserId`, que quitaba la arroba y pasaba a mayúsculas, sigue
  existiendo para declararlo en un perfil.

El identificador sigue saliendo de `preferred_username`, que es un claim
estándar de OpenID Connect y no de un proveedor.
