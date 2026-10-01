# profile

Las convenciones de una organización, declaradas una sola vez. Es la segunda
mitad de Nova: una forma correcta y genérica de construir servicios, y un lugar
para que cada organización la adapte a como trabaja sin forkearla. La decisión
está en ADR-036.

```bash
pnpm add @ahincho/nova-nestjs
```

## Por qué existe

Los defaults de Nova son genéricos: el puerto sale de `PORT`, los roles del
claim `roles` de RFC 9068, y no hay ningún prefijo de secretos. Son los correctos
para cualquiera, y por eso no son los de nadie en particular.

Una organización tiene los suyos: su plataforma inyecta el puerto en otra
variable, su proveedor de identidad pone los roles en otro lado, sus secretos
llegan con un nombre fijo. Todo eso se podía pasar como opciones, servicio por
servicio. Con veinte servicios son veinte copias de las mismas nueve opciones, y
la deriva entre esas copias es exactamente el problema que Nova existe para
cerrar.

## Declararlo

Un perfil vive en su propio paquete, que publica la organización:

```ts
import { NovaEnvelopeStandard, defineProfile } from '@ahincho/nova-nestjs';

export const acme = defineProfile({
  name: 'acme',

  bootstrap: {
    portVariables: ['APP_PORT', 'PORT'],
    secrets: { prefix: 'SECRET_' },
    globalPrefix: 'api/v1',
  },

  health: { legacyPath: 'api/v1/health' },

  auth: {
    rolesClaim: 'realm_access.roles',
    ignoredRoles: ['offline_access', 'uma_authorization'],
    ignoredRolePrefixes: ['default-roles-'],
  },

  apiStandard: {
    standard: new NovaEnvelopeStandard({
      codes: { byStatus: { 502: 'BAD_GATEWAY' } },
    }),
  },
});
```

`defineProfile` sólo verifica el tipo y que tenga nombre: existe para que un
perfil mal escrito falle al compilar el paquete del perfil, no al arrancar un
servicio.

## Usarlo

```ts
// app.module.ts
NovaModule.forRoot({ profile: acme, config: { load: [academic] } });

// main.ts
void bootstrap(AppModule, { profile: acme });
```

**Se declara en dos lugares, y es a propósito.** Los secretos se desdoblan antes
de que exista la aplicación, así que `bootstrap()` necesita el perfil antes de
poder leer el módulo; y el módulo se configura cuando se importa, antes de que
`bootstrap()` corra. Para que las dos declaraciones no se separen, `NovaModule`
registra el nombre del perfil y **`bootstrap()` corta el arranque si no
coincide** con el suyo:

```
NovaModule.forRoot() received the profile acme but bootstrap() received none.
Pass the same profile to both.
```

## El orden

```
defaults de Nova  <  perfil  <  opciones del servicio
```

El servicio sigue pudiendo cambiar cualquier cosa, opción por opción de primer
nivel: `http: { defaultTimeoutMs: 1000 }` pisa el timeout del perfil y conserva
sus cabeceras. Un `undefined` explícito no borra el valor del perfil.

## Lo que un perfil no puede hacer

**No toca una regla del núcleo.** Ve las mismas opciones y los mismos puertos
que ve un servicio, así que lo que la plataforma deja fijo -el 5xx sin detalle,
las sondas fuera del estándar, el id de correlación- sigue fijo.

**No enciende la autenticación.** Declara cómo se lee un token; la enciende el
servicio declarando `auth`, porque el guard es global y un perfil que la
activara dejaría en 401 a todo servicio interno de la organización.

**No configura los upstreams.** `config` es de cada servicio: qué llama un
servicio no es una convención de la organización.

## Qué va en un perfil y qué no

| Va en el perfil                                     | Va en el servicio                     |
| --------------------------------------------------- | ------------------------------------- |
| la variable del puerto que inyecta la plataforma    | sus upstreams                         |
| el prefijo de los secretos                          | un secreto que no sigue la convención |
| el prefijo de las rutas y la ruta heredada de salud | sus chequeos de disponibilidad        |
| cómo se lee un token de su proveedor                | si pide token o no                    |
| su catálogo de códigos de error                     | un timeout distinto para una llamada  |

La regla: **si dos servicios de la organización lo escribirían igual, va en el
perfil.**

## Dónde vive

Fuera de Nova, en un paquete de la organización con su propio versionado. Tiene
otro consumidor -los servicios de esa organización- y otro ciclo de vida -cambia
cuando la organización decide, no cuando Nova publica-, que es lo que justifica
un paquete aparte.

Nova no publica ningún perfil. El servicio de ejemplo trae uno propio para
mostrar el mecanismo sin depender del paquete de nadie.
