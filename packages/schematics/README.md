# @ahincho/nova-nestjs-schematics

Generadores para servicios NestJS de Nova Platform. Existen para que la forma
canónica **se genere en vez de copiarse**, que es como aparecen tres versiones
distintas del cliente del mismo upstream.

```bash
pnpm add -D @ahincho/nova-nestjs-schematics
```

## Crear un servicio entero

```bash
pnpm dlx @ahincho/nova-nestjs-schematics service academic-acl
pnpm dlx @ahincho/nova-nestjs-schematics service home-bff --style bff

# con su primer contexto acotado -o su primer feature- ya dentro y cableado
pnpm dlx @ahincho/nova-nestjs-schematics service academic-acl --feature buildings
```

Sin instalar nada, desde cualquier directorio. Dentro de un proyecto que ya
tenga la colección también sirve el CLI de Nest:

```bash
nest g -c @ahincho/nova-nestjs-schematics service home-bff --style=bff
```

El binario propio existe porque **sin él no había forma cómoda de crear el
primer servicio**: `nest g -c` necesita un proyecto que todavía no existe, y
`pnpm dlx` sobre un paquete sin binario corta con `ERR_PNPM_DLX_NO_BIN`. Sumarle
la CLI del DevKit con `--package` tampoco alcanzaba, porque su motor resuelve la
colección contra el directorio actual y no contra el que arma `dlx`. Acá la
colección se resuelve desde el propio binario, así que da igual desde dónde se
invoque.

`--dry-run` muestra lo que haría sin escribir, y **nunca se enciende solo**. Es
la diferencia con la CLI del DevKit, que lo deriva del modo debug y ese del
aspecto de la ruta de la colección: el mismo comando escribe en una máquina y no
escribe en otra, sin decirlo y saliendo con 0.

Deja un servicio que arranca y pasa su propia puerta de calidad:

```bash
cd academic-acl && pnpm install && pnpm verify
```

Trae el `package.json` con **los tres paquetes de la plataforma y nada más**, el
`pnpm-workspace.yaml` con su `publicHoistPattern`, los dos `tsconfig`, el
`nest-cli.json`, el `.oxlintrc.json`, el `vitest.config.mjs`, el `main.ts` con
`bootstrap()`, el `app.module.ts` con `NovaModule.forRoot()`, un test de las
sondas y las reglas de arquitectura.

### Y nace con su CI

`.github/workflows/ci.yml` corre `install`, `peers check`, `verify`, construye la
imagen y **levanta el contenedor** hasta que la sonda contesta. Un servicio sin
CI es un servicio donde la puerta de calidad existe y no la corre nadie.

**Antes del primer push hay que correr `pnpm install` y commitear el
`pnpm-lock.yaml`.** El generador no lo escribe -resolver el árbol es lo que hace
el install, y hacerlo acá dejaría un lockfile congelado en la versión del día en
que se generó-, y el workflow instala con `--frozen-lockfile`, que es lo correcto
en CI. Sin ese archivo la primera corrida muere en el primer paso.

[`ahincho/nova-example-08-nestjs-generated`](https://github.com/ahincho/nova-example-08-nestjs-generated)
es exactamente lo que sale de este generador, empujado sin editar una línea. Sirve
para mirar el resultado antes de generar, y para comprobar que este workflow corre
de verdad y no sólo en una prueba unitaria.

La versión de Node vive en un solo lugar del workflow y viaja al build de la
imagen como `--build-arg`: si el runner y la imagen se separan, se compila con
un Node distinto al que corre en producción.

El paso de la imagen sólo declara `NODE_AUTH_TOKEN`. `nova docker` encuentra la
credencial solo -busca el npmrc donde npm lo busca y resuelve el marcador que
`setup-node` deja ahí-, así que no hay que escribir ningún archivo a mano.

Y trae dos archivos que no se ven hasta que faltan. El `.npmrc` apunta el scope
`@ahincho` a GitHub Packages: sin él, `pnpm install` lo busca en npmjs y corta
con un 404. El `.gitattributes` fija `eol=lf`: sin él, un clon en Windows queda
en CRLF y `nova format:check` falla en local mientras pasa en el runner de
Linux, que es el falso negativo más caro de diagnosticar de los dos.

El registry sí pide credencial, y **no va en el `.npmrc` del repositorio** -pnpm
ignora las variables de entorno en credenciales que vengan de un archivo
versionado, precisamente para que nadie se lleve el token cambiando la URL en un
pull request-. Una vez por máquina:

```bash
pnpm config set "//npm.pkg.github.com/:_authToken" <token con read:packages>
```

En CI lo escribe `actions/setup-node` con `registry-url` y `NODE_AUTH_TOKEN`.

### Lo que no genera

**No hay `src/common/` ni `src/core/`.** El filtro global, el interceptor del
sobre, las sondas de salud, el cliente HTTP, la configuración, el contexto de
petición y el logger llegan dentro de `@ahincho/nova-nestjs`. En los templates
de los que sale esta forma, esas dos carpetas eran **entre el 40 % y el 50 % de
`src`**: un servicio nace con la mitad de los archivos que antes había que
copiar y después mantener sincronizados.

Tampoco genera un `Dockerfile`: la imagen base, el usuario y el puerto dependen
de dónde despliegues, y uno inventado seria peor que ninguno.

### `--feature` deja el esqueleto lleno

Sin él, el servicio nace con `main.ts` y `app.module.ts` y nada más: es lo que
conviene cuando todavía no se sabe qué va a atender. Con él, el primer contexto
acotado -o el primer feature, en un BFF- se genera **con el mismo schematic que
los siguientes** y queda importado en el `app.module.ts`.

Que sea el mismo schematic no es un detalle de implementación. Copiar sus
plantillas dentro del generador de servicio es como el primer contexto y el
octavo terminan teniendo dos formas distintas de lo mismo.

Un contexto generado arranca de verdad: su puerto de salida queda atado a un
adaptador en memoria que devuelve `null`, así que el recorrido completo
-controlador, servicio, puerto, adaptador, sobre de error- responde un 404
desde el primer día. Ese adaptador **está para reemplazarse** por el cliente
REST de `adapter/out/restclient/`, y el servicio no se entera del cambio porque
depende del puerto.

### Los dos sabores

| `--style` | Forma                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `acl`     | hexagonal por contexto acotado: `adapter/in`, `adapter/out`, `domain/`, `exception/`, `port/`, `service/` |
| `bff`     | `features/<pantalla>/` con los adaptadores de salida afuera, en `src/upstream/`                           |

Es la misma distinción que hace `feature`, y por el mismo motivo.

### Las reglas de arquitectura son genéricas

`.dependency-cruiser.js` sale con una regla por frontera, cada una con su motivo
escrito, y `nova lint:arch` las corre dentro de `nova verify`.

**Ninguna enumera contextos a mano.** Un comodín cubre los que existan y los que
se agreguen:

```js
const CONTEXT = '[^/]+';
{
  name: 'service-must-not-import-adapter',
  from: { path: `^src/(${CONTEXT})/service/` },
  to: { path: '^src/$1/adapter/' },
}
```

El `name` va en inglés porque es un identificador -aparece en la salida y es la
clave de un baseline de `--ignore-known`-; el `comment` va en español, que es lo
que lee quien ve saltar la regla.

Es deliberado: una regla que lista los contextos uno por uno **sigue en verde
cuando aparece el octavo**, y nadie se entera de que dejó de mirarlo.

## Declarar un upstream

```bash
nest g -c @ahincho/nova-nestjs-schematics upstream academic-orchestrator
```

Escribe cuatro archivos en `src/upstream/academic-orchestrator/`:

| Archivo           | Qué trae                                                              |
| ----------------- | --------------------------------------------------------------------- |
| `.config.ts`      | `defineUpstream()`; lee `ACADEMIC_ORCHESTRATOR_URL` y `_TIMEOUT_MS`   |
| `.client.ts`      | cliente sobre `HttpClientService`, con el timeout de su configuración |
| `.module.ts`      | `ConfigModule.forFeature()` y el cliente exportado                    |
| `.client.spec.ts` | dos pruebas que ya pasan                                              |

El nombre acepta kebab-case o camelCase; el prefijo de las variables sale de él
y coincide con lo que lee `defineUpstream()` en tiempo de ejecución.

## Crear un feature

```bash
nest g -c @ahincho/nova-nestjs-schematics feature buildings              # acl
nest g -c @ahincho/nova-nestjs-schematics feature courses --style bff
```

Los dos estilos son **la misma arquitectura hexagonal**. Lo que cambia es dónde
queda el adaptador de salida:

|                     | `acl` (por defecto)            | `bff`                                 |
| ------------------- | ------------------------------ | ------------------------------------- |
| Ubicación           | `src/<name>/`                  | `src/features/<name>/`                |
| Adaptador de salida | dentro, en `adapter/out/`      | afuera, en `src/upstream/` compartido |
| `domain/`           | sí                             | no; el contrato es el DTO             |
| Puerto de salida    | `port/out/find-<name>.port.ts` | el cliente del upstream               |

Un BFF saca sus adaptadores a `upstream/` porque varios features llaman al mismo
servicio. Un ACL los deja dentro y agrega `domain/`, que es lo que le permite
absorber un cambio del sistema legado sin propagarlo.

## Opciones

| Opción  | Por defecto                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------- |
| `name`  | requerido; primer argumento                                                                     |
| `style` | `acl` (en `service` y en `feature`)                                                             |
| `path`  | `<name>` en `service`; `src/upstream/<name>`, `src/<name>` o `src/features/<name>` en los otros |

## Sobre los tests de este paquete

Un paquete de schematics publica **plantillas**, no sólo código, y el runner las
carga desde disco. Por eso la suite de integración corre contra `dist` — probar
el fuente probaría algo que nadie instala. `pnpm verify` compila antes de
testear, que es el orden que esos tests asumen.
