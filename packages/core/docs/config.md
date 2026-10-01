# config

Lectores tipados de variables de entorno, declaración de upstreams y política de
CORS para servicios NestJS de Nova Platform.

```bash
pnpm add @ahincho/nova-nestjs
```

## Declarar un upstream

Es la pieza que más paga. Una línea reemplaza el archivo de configuración que
cada servicio copiaba por upstream:

```ts
import { defineUpstream } from '@ahincho/nova-nestjs';

export const academicOrchestrator = defineUpstream('academic-orchestrator');
// lee ACADEMIC_ORCHESTRATOR_URL y ACADEMIC_ORCHESTRATOR_TIMEOUT_MS
```

```ts
@Module({
  imports: [ConfigModule.forFeature(academicOrchestrator)],
})
export class AcademicOrchestratorModule {}
```

```ts
constructor(
  @Inject(academicOrchestrator.KEY)
  private readonly config: ConfigType<typeof academicOrchestrator>,
) {}
// config.url, config.timeoutMs
```

**El servicio muere al arrancar si la URL nunca se inyectó**, nombrando la
variable. Sin eso, la variable faltante sobrevive a un despliegue verde y aparece
como un 500 la primera vez que alguien llama esa ruta, semanas después.

El nombre acepta kebab-case, camelCase y snake_case; los tres derivan el mismo
prefijo. Si la variable no sigue el nombre, `envPrefix` lo dice explícito.

## Leer variables

```ts
import {
  requireEnv,
  optionalEnv,
  numberEnv,
  booleanEnv,
  urlEnv,
} from '@ahincho/nova-nestjs';

requireEnv('SERVICE_NAME'); // falla si falta o está en blanco
optionalEnv('LOG_LEVEL', 'info');
numberEnv('PORT', 3000); // falla si no es un número, y dice cuál era
booleanEnv('LOG_PRETTY', false); // true/false, 1/0, yes/no
urlEnv('ACADEMIC_ORCHESTRATOR_URL'); // http(s), sin barra final
```

Todos lanzan `EnvironmentError` nombrando la variable. Tres detalles que evitan
una investigación:

- **Un valor en blanco cuenta como faltante.** Es lo que produce una task
  definition con el campo vacío, y tratarlo como presente convierte un error de
  configuración en una falla en otro lado.
- **`numberEnv` reporta el texto que encontró.** `Number('8080abc')` es `NaN` y
  `Number('')` es `0`: sin el texto, un timeout en cero no se explica.
- **`urlEnv` quita la barra final.** `${base}/path` con barra final produce una
  doble barra, y algunos gateways la enrutan a una regla distinta de la probada.

## El ambiente

```ts
import { appEnvironment } from '@ahincho/nova-nestjs';

appEnvironment(); // 'development' | 'qa' | 'production', leído de NODE_ENV
```

Existe para que **una sola imagen sirva para los tres ambientes**. El artefacto
que se probó en dev es el que llega a prod, byte por byte; construir uno por
ambiente significa que lo que se aprobó no es lo que se despliega.

Los valores son los que inyectan las task definitions de verdad, no una
convención inventada acá:

| Bloque de vars | `NodeEnv`     |
| -------------- | ------------- |
| `dev:`         | `development` |
| `qa:`          | `qa`          |

`production` es el que trae la imagen y el que usará prd cuando exista.

### Sin inyectar nada cae en el más restrictivo

La imagen fija `NODE_ENV=production`, así que un contenedor que nadie configuró
se comporta como producción -sin documentación publicada, por ejemplo- en vez de
abrirse. El default equivocado en esta decisión se paga caro en una sola
dirección, y esta es la barata.

### Pero no acepta cualquier cosa

```
EnvironmentError: Environment variable NODE_ENV must be one of
development, qa, production, but was "dev"
```

Un `dev` mal escrito no es «algo que no es producción»: es una task definition
rota. Que el contenedor lo diga al arrancar es mejor que comportarse de una
forma que nadie pidió.

### La consecuencia de usar `NODE_ENV` para esto

En qa vale `qa`, así que **todo lo que ramifica sobre `NODE_ENV === 'production'`
-Express, Nest, varias librerías- corre en modo desarrollo ahí**: más
verborrágico, sin algunas cachés. Es la convención que ya está viva en los siete
BFF, y conviene saberla en vez de descubrirla comparando una traza de qa con una
de prod.

## CORS

```ts
import { buildCorsOptions } from '@ahincho/nova-nestjs';

app.enableCors(
  buildCorsOptions({ origins: process.env.CORS_ALLOWED_ORIGINS ?? '' }),
);
```

La lista es toda la política: sin ramas por ambiente y sin loopback implícito.
**Una lista vacía no permite ningún origen**, así que un contenedor que nadie
configuró falla cerrado. Las credenciales quedan en `false` a propósito: la
autenticación viaja en `Authorization`, y credenciales más origen reflejado es la
combinación que filtra una sesión.

La política permite `Idempotency-Key`, para que un navegador pueda reintentar una
compra con su clave, y expone `Idempotent-Replayed` y `Retry-After`, para que el
script sepa si la respuesta es una repetida y cuánto esperar ante un 409
(ADR-047). El BFF no aplica la idempotencia: la pasa al servicio que la aplica.

## Módulo

```ts
@Module({
  imports: [NovaConfigModule.forRoot({ load: [academicOrchestrator] })],
})
export class AppModule {}
```

Envoltorio delgado sobre `ConfigModule.forRoot()` que fija las dos opciones que
todos los servicios ponían igual: global, y con `expandVariables` para poder
expandir un secreto inyectado como un único JSON. Es `async` porque el de Nest lo
es; Nest acepta una promesa en `imports`, así que la llamada no cambia.

`validationSchema` se pasa tal cual a `@nestjs/config`. **Desde la versión 12
espera un esquema [Standard Schema](https://standardschema.dev/) -Zod, Arktype,
valibot-, no uno de Joi**, y ese es el cambio incompatible de subir a NestJS 12:
un servicio que traía un esquema de Joi tiene que cambiarlo.

La plataforma no depende de ninguno de los dos. Un servicio que no quiera sumar
una librería tiene dos salidas: omitirlo y validar dentro de sus propios
namespaces, o pasarle `validate` a `ConfigModule` directamente, que es una
función `(config) => config` y no necesita nada instalado.

## Los secretos inyectados

Una task definition de ECS que inyecta un secreto de Secrets Manager entero lo
pone en **una sola variable con el JSON completo**, no una variable por clave.
ECS permite seleccionar una clave agregando `:CLAVE::` al ARN, pero cuando la
plataforma no lo usa, parsear el JSON es responsabilidad de la aplicación: es el
contrato, no un parche.

```ts
void bootstrap(AppModule, { secrets: { prefix: 'CREDENTIALS_' } });
```

Corre **antes de que exista la aplicación**, porque cada `registerAs` valida sus
variables al instanciarse el módulo. De ahí para abajo todo lee variables planas
sin enterarse de que hubo un secreto.

**No lleva ninguna lista de nombres.** Descubre por convención cualquier variable
que empiece con el prefijo; eso alcanza para los servicios de hoy y para los que
todavía no existen. Escribir los nombres en la plataforma haría que agregar un
secreto exija publicar una versión del framework.

**El prefijo es de la organización, no de Nova.** Por defecto no hay ninguno: la
plataforma no conoce el entorno donde corre, y un prefijo adivinado puede toparse
con una variable que se llama así y no trae JSON, lo que corta el arranque. Quien
sabe que ninguna otra variable empieza así es la organización, y lo declara en su
[perfil](profile.md); con el perfil, el desdoblado se enciende solo y un servicio
lo apaga con `secrets: false`.

Tres fuentes, y se suman:

| Fuente         | Para qué                                                             |
| -------------- | -------------------------------------------------------------------- |
| `prefix`       | la convención de la organización — `{ prefix: 'CREDENTIALS_' }`      |
| `variables`    | el servicio nombra la suya — `{ variables: ['LEGACY_CREDENTIALS'] }` |
| `NOVA_SECRETS` | operaciones la agrega a la task definition, sin tocar el código      |

`secrets: true` sin perfil sólo lee `NOVA_SECRETS`.

La última es la que importa en esta topología: el ambiente lo gobierna
operaciones y el código lo gobierna el equipo, y un nombre nuevo no debería
necesitar a los dos.

**Ausente y malformado son casos distintos, a propósito.** Un secreto ausente no
falla — es lo que permite que una corrida local y los tests anden con sus propias
variables. Un JSON roto corta el arranque, que es lo contrario de lo intuitivo y
es lo correcto: dejarlo pasar produce un contenedor que muere sin decir por qué,
el fallo más caro de diagnosticar de esta familia.

El mensaje del error **nombra la variable y nunca su contenido**. Por eso se
descarta el error de `JSON.parse`: cita el texto que no pudo leer, y ese texto es
el secreto.

## Los secretos de un almacén

Un servicio también puede leer sus secretos de un almacén al arrancar: Vault o
AWS Secrets Manager. Cada almacén es un paquete aparte, así que un servicio que
usa Vault no instala el SDK de AWS
([ADR-049](https://github.com/ahincho/nova-shared-01-docs/blob/main/adrs/shared/ADR-049-secretos-en-quarkus-y-nestjs.md)):

| Fuente                | Paquete                                            |
| --------------------- | -------------------------------------------------- |
| `vault`               | `@ahincho/nova-nestjs-secrets-vault`               |
| `aws-secrets-manager` | `@ahincho/nova-nestjs-secrets-aws-secrets-manager` |

```ts
void bootstrap(AppModule, { secrets: { imports: ['vault:plaza-bff'] } });
```

O desde la task definition, sin tocar el código:

```bash
NOVA_SECRETS_IMPORT=vault:plaza-bff,optional:aws-secrets-manager:prod/plaza-bff/db
```

**Es la misma forma que en Spring Boot y en Quarkus**: `<fuente>:<referencia>`,
con `optional:` delante si puede faltar, y la misma variable. Quien opera un
servicio pide un almacén igual sin saber en qué framework está escrito.

- **El servicio no registra el almacén.** `vault:` hace que la plataforma cargue
  `@ahincho/nova-nestjs-secrets-vault` desde las dependencias del servicio, así
  que cambiar de almacén es cambiar una dependencia y una línea. Si el paquete
  no está instalado, el arranque corta diciendo cuál instalar.
- **Un pedido se lee aunque el servicio no declare nada**, porque es explícito:
  solo `secrets: false` lo apaga.
- **Un secreto que falta corta el arranque**, salvo que se pida con `optional:`.
  Quien escribió la referencia prometió que existe.
- **Un pedido gana sobre lo que se desdobla del entorno**, y entre dos pedidos
  gana el último. Con `override: false`, ninguno pisa una variable que ya estaba
  en el entorno.
- **Cada llamada lleva un timeout** de 5 segundos, sin reintentos, como el
  cliente HTTP.

La configuración de cada almacén lleva los mismos nombres que en Java, escritos
como variables de entorno:

| Variable                                             | Por defecto                      |
| ---------------------------------------------------- | -------------------------------- |
| `NOVA_SECRETS_VAULT_ADDRESS`                         | `VAULT_ADDR`                     |
| `NOVA_SECRETS_VAULT_TOKEN`                           | `VAULT_TOKEN`                    |
| `NOVA_SECRETS_VAULT_APP_ROLE_ROLE_ID` y `_SECRET_ID` | AppRole; gana sobre el token     |
| `NOVA_SECRETS_VAULT_APP_ROLE_MOUNT`                  | `approle`                        |
| `NOVA_SECRETS_VAULT_MOUNT`                           | `secret`, el motor KV versión 2  |
| `NOVA_SECRETS_VAULT_TIMEOUT`                         | `5s`                             |
| `NOVA_SECRETS_AWS_SECRETS_MANAGER_REGION`            | `AWS_REGION` y la cadena del SDK |
| `NOVA_SECRETS_AWS_SECRETS_MANAGER_ENDPOINT`          | solo para un emulador            |
| `NOVA_SECRETS_AWS_SECRETS_MANAGER_TIMEOUT`           | `5s`                             |

Un valor también se puede pasar en código con `secrets: { settings: { ... } }`,
con la clave de Java, como `'nova.secrets.vault.mount'`. Las credenciales de AWS
salen de la cadena del SDK: dentro de ECS, del rol de la tarea.

**Un secreto de AWS es un JSON**, y el almacén lo abre con las mismas reglas que
el desdoblado del entorno. Por eso un servicio puede pasar de recibirlo en
`CREDENTIALS_DB`, inyectado por ECS, a pedirlo con `aws-secrets-manager:`, y obtiene
exactamente las mismas variables.

Para escribir otro almacén alcanza con un paquete que se llame
`@ahincho/nova-nestjs-secrets-<fuente>` y exporte un `secretSourceProvider` con
ese nombre. Los tipos (`SecretSourceProvider`, `SecretSource`) y las piezas que
aplican las reglas (`secretFromJson`, `durationSetting`, `SecretSourceError`)
salen de `@ahincho/nova-nestjs`.
