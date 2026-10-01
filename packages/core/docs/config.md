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
void bootstrap(AppModule, { secrets: { prefix: 'SECRET_' } });
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
| `prefix`       | la convención de la organización — `{ prefix: 'SECRET_' }`           |
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
