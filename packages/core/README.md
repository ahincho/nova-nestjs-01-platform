# @ahincho/nova-nestjs

El meta-framework de Nova Platform para NestJS: un módulo y una llamada de
arranque que conectan todo lo demás.

```bash
pnpm add @ahincho/nova-nestjs
```

Pone detrás de una sola dependencia lo que una aplicación necesita, igual que
`spring-boot-starter`, y eso incluye **NestJS mismo**: `@nestjs/common`,
`@nestjs/core`, `@nestjs/config`, `@nestjs/platform-express`, `@nestjs/terminus`,
`class-validator`, `class-transformer`, `reflect-metadata` y `rxjs` vienen con este
paquete, en las versiones contra las que corre su suite. Un servicio no los declara.

Para poder importarlos hace falta una línea en el `pnpm-workspace.yaml` del
servicio, porque pnpm aísla `node_modules` y un paquete transitivo no se resuelve:

```yaml
publicHoistPattern:
  - '@nestjs/*'
  - rxjs
  - reflect-metadata
  - class-validator
  - class-transformer
```

Cada módulo tiene su carpeta en `src/` y su documento:

| Módulo                                   | Qué resuelve                                               |
| ---------------------------------------- | ---------------------------------------------------------- |
| [`api-standard`](docs/api-standard.md)   | el sobre `{ success, status, data, errors }` y sus códigos |
| [`api`](docs/api.md)                     | interceptor, filtro y `ValidationPipe` que lo aplican      |
| [`errors`](docs/errors.md)               | errores por capa, sin Nest, y sus tres puertos (ADR-031)   |
| [`auth`](docs/auth.md)                   | JWT opcional: guard global, `@Public()` y `@CurrentUser()` |
| [`config`](docs/config.md)               | variables de entorno tipadas, upstreams y CORS             |
| [`http`](docs/http.md)                   | cliente HTTP saliente con contexto y errores de upstream   |
| [`observability`](docs/observability.md) | contexto de request, `x-request-id` y opciones de pino     |
| [`health`](docs/health.md)               | sondas `live`, `ready` y heredada sobre terminus           |
| [`openapi`](docs/openapi.md)             | documento OpenAPI, su interfaz y el sobre documentado      |

## Un servicio completo

```ts
// app.module.ts
import { NovaModule, defineUpstream } from '@ahincho/nova-nestjs';

export const academicOrchestrator = defineUpstream('academic-orchestrator');

@Module({
  imports: [
    NovaModule.forRoot({
      config: { load: [academicOrchestrator] },
      health: { readinessChecks: [databaseCheck] },
    }),
    CoursesModule,
  ],
})
export class AppModule {}
```

```ts
// main.ts, completo
import { bootstrap } from '@ahincho/nova-nestjs';
import { AppModule } from './app.module';

void bootstrap(AppModule, {
  cors: { origins: process.env.CORS_ALLOWED_ORIGINS ?? '' },
});
```

Eso reemplaza los quince archivos que cada servicio copiaba en `src/common` y
`src/core`.

## Por qué `forRoot()` y no un escaneo

Spring Boot activa un starter por encontrarlo en el classpath. **NestJS no tiene
escaneo de classpath**, así que la activación es esta llamada, y es toda la
superficie donde se enciende el comportamiento de la plataforma.

Lo que ningún equipo debería tener que escribir es la última conexión que hace
este módulo: `nestjs-http` declara que quiere cabeceras salientes de algún lado, y
`nestjs-observability` sabe cuál es la petición en curso. Ninguno importa al otro
— se encuentran acá, y por eso los dos siguen sirviendo por separado.

## Qué hace `bootstrap()`

Las cuatro decisiones que se estaban tomando de nuevo en cada `main.ts`:

- El `ValidationPipe` con `validationExceptionFactory`, para que un DTO fallido
  vuelva como el sobre estándar con una entrada por restricción.
- CORS con la política que declara una sola variable, o apagado si no se pasa.
- Bind a `0.0.0.0`: atarse a localhost dentro de un contenedor deja al servicio
  inalcanzable desde el balanceador mientras se ve sano desde una shell local.
- **`globalPrefix` no mueve las sondas de salud.** Un prefijo que convierte
  `/health/live` en `/api/health/live` hace que la tarea se desregistre a los
  nueve segundos y el despliegue muera diez minutos después.

Y dos que llegaron con NestJS 12:

- **Una ruta duplicada corta el arranque** (`routeConflictPolicy.duplicate`).
  Dos registros con el mismo método, ruta, host y versión son siempre un error:
  uno de los dos manejadores es código muerto y cuál gana depende del orden. Una
  ruta ensombrecida -`/users/me` contra `/users/:id`- solo avisa, porque a veces
  es deliberada.
- **`return503OnClosing`**, la otra mitad del apagado ordenado. `enableShutdownHooks`
  avisa a los módulos; esto decide qué contesta el proceso mientras se apaga.
  Actúa sobre las conexiones **ya establecidas**, que es la distinción que
  importa al probarlo — está en [docs/health.md](docs/health.md#el-503-del-apagado-es-sobre-conexiones-ya-abiertas).

| Opción                    | Por defecto                                         |
| ------------------------- | --------------------------------------------------- |
| `port`                    | la variable `PORT`, o 3000                          |
| `host`                    | `0.0.0.0`                                           |
| `cors`                    | apagado                                             |
| `logger`                  | ninguno; los logs se bufferean hasta que se instala |
| `globalPrefix`            | ninguno                                             |
| `healthPath`              | `'health'`                                          |
| `forbidUnknownProperties` | `true`                                              |
| `routeConflicts`          | `{ duplicate: 'error', shadow: 'warn' }`            |

`forbidUnknownProperties` está encendido porque un campo ignorado en silencio es
como un cliente termina creyendo que mandó un filtro que el servicio nunca aplicó.

## Peers

`@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `rxjs`, `reflect-metadata`,
`class-validator` y `class-transformer`. Los dos últimos los exige el
`ValidationPipe` de Nest en runtime: se declaran para que falte visible al
instalar, y no al arrancar.
