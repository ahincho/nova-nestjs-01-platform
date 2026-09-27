# nova-nestjs

Meta-framework de **Nova Platform** para NestJS. Monorepo de paquetes publicados
en GitHub Packages bajo el scope `@ahincho`.

Es el equivalente en NestJS de lo que
[`nova-java-spring-boot-starter`](https://github.com/ahincho/nova-java-12-spring-boot-starter)
y [`nova-java-quarkus-parent`](https://github.com/ahincho/nova-java-15-quarkus-parent)
son en Java. Parte de la arquitectura de cinco niveles del
[ADR-001](https://github.com/ahincho/nova-shared-01-docs), pero la colapsa en tres
paquetes; el porqué está más abajo.

## Por qué un monorepo y no un repo por paquete

En Java la coordinación de versiones ocurre en el **consumidor**: un BOM se importa
y un parent se hereda. npm no tiene ninguno de los dos mecanismos. Entonces la
coordinación tiene que ocurrir en el **productor**, y ese productor es el monorepo.

Es lo que hacen NestJS, Angular y Backstage. Cada paquete se publica con su versión,
su changelog y su página de npm; el consumidor no distingue.

## Una sola dependencia de runtime

Un servicio declara `@ahincho/nova-nestjs` y **nada más**. NestJS, `class-validator`,
`rxjs`, `reflect-metadata` y terminus llegan con él, en las versiones exactas contra
las que la plataforma corre su suite.

```jsonc
// package.json de un servicio, entero
"dependencies": {
  "@ahincho/nova-nestjs": "^0.4.0"
}
```

Antes eran `peerDependencies`, y eso dejaba la elección del lado del servicio: ocho
rangos escritos en cada repositorio, que cada equipo podía mover por su cuenta. Con
la versión adentro del paquete, subir NestJS es publicar la plataforma, y ningún
servicio queda en una versión que la plataforma no probó.

**Cuesta una línea de configuración en el consumidor**, y no es opcional. pnpm aísla
`node_modules`, así que un paquete que llega por transitividad no se puede importar:
sin esto, `import { Module } from '@nestjs/common'` corta con `TS2307`.

```yaml
# pnpm-workspace.yaml del servicio
publicHoistPattern:
  - '@nestjs/*'
  - rxjs
  - reflect-metadata
  - class-validator
  - class-transformer
```

Es la contrapartida honesta del modelo: se gana que nadie elija la versión, se pierde
el aislamiento estricto de pnpm para esos paquetes. Con npm o yarn no haría falta,
porque no aíslan.

## Paquetes

| Paquete                                                  | Qué es                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`@ahincho/nova-nestjs`](packages/core)                  | runtime: sobre de respuesta, configuración, cliente HTTP, contexto de request, salud, `NovaModule` y `bootstrap()` |
| [`@ahincho/nova-nestjs-toolchain`](packages/toolchain)   | el comando `nova` y los presets de TypeScript, oxlint y Vitest                                                     |
| [`@ahincho/nova-nestjs-schematics`](packages/schematics) | generadores `feature` (bff y acl) y `upstream`                                                                     |

Los tres se publican con **un solo número de versión**, como hace `@nestjs/*`.

### Por qué tres y no once

Hasta la 0.1 eran once: una librería pura, cinco conectores, un agregador, tres
presets y los schematics, siguiendo los cinco niveles al pie de la letra. Nadie
instalaba las piezas sueltas —el servicio de ejemplo ya consumía el agregador— y
cada cambio en `api-standard` arrastraba tres bumps en cascada. Los niveles
existen para separar lo que tiene distinto consumidor o distinto ciclo de vida,
y acá sólo hay dos de esas fronteras: el runtime que una aplicación importa, y
las herramientas que sólo corren en desarrollo. Los schematics quedan aparte
porque Nest CLI resuelve una colección por nombre de paquete.

Dentro de `core` cada módulo conserva su carpeta y su `index.ts`, así que la
frontera sigue visible en el código; lo que desapareció es el costo de
publicarla.

## Cómo lo consume una aplicación

Tres mecanismos distintos, y sólo uno es un `import`:

```ts
// 1. Piezas sueltas — un import normal
import { ApiResponses } from '@ahincho/nova-nestjs';

// 2. Activación — en NestJS nada se dispara solo, hay que llamarlo
@Module({ imports: [ApiStandardModule.forRoot()] })
export class AppModule {}
```

```json
// 3. Presets — se heredan desde el archivo de configuración
{ "extends": "@ahincho/nova-nestjs-toolchain/tsconfig/nestjs.json" }
```

## Desarrollo

```bash
pnpm install
pnpm verify
```

| Comando          | Qué hace                                   |
| ---------------- | ------------------------------------------ |
| `pnpm verify`    | build + typecheck + cobertura + formato    |
| `pnpm build`     | compila en orden topológico                |
| `pnpm typecheck` | `tsc --noEmit` incluyendo los `*.spec.ts`  |
| `pnpm test`      | corre la suite de cada paquete             |
| `pnpm test:cov`  | igual, con el umbral de cobertura del 80 % |
| `pnpm changeset` | registra un cambio para el próximo release |

**El build va antes que el typecheck y que los tests.** Un paquete consume a su
hermano por el `dist` que publica, igual que en Java se compila la librería antes
que su consumidor. `pnpm -r` respeta el orden topológico, así que basta con correr
`pnpm build` una vez después de clonar; `pnpm verify` ya lo hace en orden.

## Versionado

Conventional commits y [Changesets](https://github.com/changesets/changesets).
Cada PR que toca un paquete publicable lleva su changeset; `changeset version`
calcula los bumps y `changeset publish` sube al registry.

El stack Java usa `release-please` porque cada repo se versiona solo. Acá el bump
tiene que propagarse entre paquetes del mismo commit, que es justo lo que Changesets
resuelve y `release-please` no.

### Nada se publica sin instalarse en un servicio

**El monorepo no puede ver un conflicto de peers.** Cada paquete del workspace
resuelve su propio árbol, así que dos dependencias incompatibles entre paquetes
distintos conviven sin problema; un servicio las aplana en uno solo y ahí el
install corta.

Así salió publicada la 0.8.0, con `pnpm verify` en verde: `@nestjs/cli` 12 trae
`chokidar` 5 y los schematics pedían Angular DevKit 20, cuyo peer es `chokidar` ^4.
El defecto lo encontró instalar el paquete ya publicado en el servicio de ejemplo.

Por eso CI y el release corren `.github/actions/consumer-check`, que empaqueta los
tres paquetes, los instala en una copia del servicio de ejemplo y corre allí el
`install`, el chequeo de peers, el build y la suite:

```bash
# lo mismo, a mano
pnpm build
pnpm consumer:pack ../una-copia-del-ejemplo
```

El script borra el lockfile y el `.npmrc` de esa copia. Lo segundo no es comodidad
de credenciales: sin ese archivo, cualquier `@ahincho/*` que la reescritura no haya
cubierto se resuelve contra npmjs y falla con un 404, así que además comprueba que
los tarballs reemplazan al registry por completo.

**Cuando el release trae un cambio incompatible**, el chequeo se traba: no se puede
publicar hasta que el ejemplo compile, y el ejemplo no compila hasta que se publique.
La salida es el input `consumer-ref` del workflow, que apunta el chequeo a la rama del
ejemplo que ya absorbió el cambio.

## Consumirlos desde otro proyecto

[`nova-nestjs-example`](https://github.com/ahincho/nova-nestjs-03-example) es el
servicio de referencia y corre siempre contra la última versión publicada. En
corto:

```bash
# .npmrc del proyecto: solo el registry, nunca la credencial
echo '@ahincho:registry=https://npm.pkg.github.com' >> .npmrc

# la credencial va en la configuracion de usuario, una sola vez
pnpm config set "//npm.pkg.github.com/:_authToken" "$(gh auth token)"

pnpm add @ahincho/nova-nestjs
```

Tres cosas que cuestan un rato descubrir solas:

- **GitHub Packages pide token incluso para un paquete público.** No hay forma
  de instalar sin credencial; eso sólo lo da npmjs.
- **La credencial no puede vivir en el `.npmrc` versionado.** pnpm se niega a
  expandir una variable de entorno ahí, porque alguien podría cambiar la URL del
  registry en un pull request y llevarse el token.
- **pnpm rechaza una versión recién publicada.** Es su política de antigüedad
  mínima, pensada para paquetes de terceros; para los propios se excluye el
  scope en `pnpm-workspace.yaml` con `minimumReleaseAgeExclude`.

## Estado

`0.x`: la API todavía se está asentando y habrá cambios que rompen entre minors.
A partir de `1.0.0` el semver es un compromiso.

## Licencia

[EPL-2.0](LICENSE), igual que el resto de Nova Platform.
