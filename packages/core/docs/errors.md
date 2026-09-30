# errors

El módulo de errores por capas de ADR-031. Quien lanza dice **qué pasó**, y la
plataforma decide el HTTP, el código y el cuerpo.

```ts
import { DomainError } from '@ahincho/nova-nestjs/errors';
```

El subpath `@ahincho/nova-nestjs/errors` **no carga Nest ni ningún framework
web**, así que el mismo caso de uso corre detrás de HTTP o de un consumidor de
cola. Lo vigilan una regla de oxlint sobre `src/errors/` y
`framework-free.spec.ts`, que sigue también los imports que salen de la carpeta.
Todo lo de acá se exporta además desde `@ahincho/nova-nestjs`, para el código
que ya carga Nest.

## Las capas y sus tipos

| Capa             | Fábrica                            | HTTP | Código del catálogo     |
| ---------------- | ---------------------------------- | ---- | ----------------------- |
| `domain`         | `DomainError.notFound`             | 404  | `NOT_FOUND`             |
| `domain`         | `DomainError.conflict`             | 409  | `CONFLICT`              |
| `domain`         | `DomainError.ruleViolation`        | 422  | `UNPROCESSABLE_ENTITY`  |
| `application`    | `ApplicationError.invalidInput`    | 400  | `BAD_REQUEST`           |
| `application`    | `ApplicationError.conflict`        | 409  | `CONFLICT`              |
| `application`    | `ApplicationError.unprocessable`   | 422  | `UNPROCESSABLE_ENTITY`  |
| `application`    | `ApplicationError.unauthenticated` | 401  | `UNAUTHORIZED`          |
| `application`    | `ApplicationError.forbidden`       | 403  | `FORBIDDEN`             |
| `application`    | `ApplicationError.rateLimited`     | 429  | `TOO_MANY_REQUESTS`     |
| `infrastructure` | `InfrastructureError.unavailable`  | 503  | `SERVICE_UNAVAILABLE`   |
| `infrastructure` | `InfrastructureError.timeout`      | 504  | `GATEWAY_TIMEOUT`       |
| `infrastructure` | `InfrastructureError.badGateway`   | 502  | `BAD_GATEWAY`           |
| `platform`       | `PlatformError.internal`           | 500  | `INTERNAL_SERVER_ERROR` |

**`domain` y `application` son esperados**: van al log en `warn`, sin stack.
**`infrastructure` y `platform` son incidentes**: van en `error`, con la causa
completa encadenada (`Caused by:`).

```ts
throw DomainError.notFound('Pedido no encontrado', { code: 'ORDER_NOT_FOUND' });

throw ApplicationError.invalidInput('La inscripción no es válida', [
  { field: 'periodId', message: 'Debe ser un entero' },
]);

throw ApplicationError.rateLimited('Demasiadas solicitudes', {
  retryAfter: 30,
});

throw InfrastructureError.timeout('academic-orchestrator', { cause });
```

## Qué ve el cliente y qué va al log

| Campo del error | Al cliente                                | Al log               |
| --------------- | ----------------------------------------- | -------------------- |
| `code` propio   | sólo en un 4xx; si no trae, el del status | el código contestado |
| `message`       | sólo en un 4xx; un 5xx lleva el genérico  | siempre              |
| `fieldErrors`   | una entrada por campo, con `field`        | `fieldErrors`        |
| `retryAfter`    | la cabecera `Retry-After`, en segundos    | no                   |
| `upstream`      | **nunca**                                 | `upstream`           |
| `cause`         | **nunca**                                 | el stack encadenado  |
| `traceId`       | `metadata.traceId`                        | `traceId`            |

```json
{
  "success": false,
  "status": 504,
  "data": null,
  "errors": [
    {
      "code": "GATEWAY_TIMEOUT",
      "message": "Internal server error",
      "field": null
    }
  ],
  "metadata": { "traceId": "3f2b8c1e-5d4a-4f6b-9a7c-2e1d0b9f8a6c" }
}
```

Con eso el cliente sabe si conviene reintentar -un 503 o un 504 sí, un 500 no-
sin conocer la topología.

**El `traceId` se toma al construir el error**, del contexto de la petición en
curso, y no al responder, cuando el contexto se puede haber perdido. En NestJS es
el id de correlación, el mismo de `x-request-id`. Fuera de una petición -un job,
un consumidor- el error nace sin él, y construirlo nunca lanza.

Al contestar, el filtro busca el id en este orden: el del error, el de la petición
en curso y el de `req.id`. Si ninguno existe, porque el error ocurrió antes de que
el middleware abriera el contexto -un cuerpo JSON que no se puede leer falla en el
`body-parser`, antes que cualquier middleware del módulo-, genera uno nuevo. Se
escribe igual en el cuerpo y en el log, así que el cliente nunca se queda sin algo
que citar.

## Lo que ya existía

- Una `HttpException` conserva su status, su `errorCode` y su mensaje, y se lee
  por su status: un 4xx es `application`; un 502, 503 o 504 es
  `infrastructure`, que es lo que lanza el cliente HTTP cuando falla un upstream;
  otro 5xx es `platform`.
- Un `UpstreamHttpError` que nadie tradujo es `infrastructure`: 504 si el
  upstream contestó 504 o 408, y 502 si contestó otra cosa.
- Cualquier otra excepción es `platform` y sale como 500.

Así un servicio migra de a poco: lo que no cambió sigue contestando el mismo
status, y ahora con `metadata.traceId`.

## Los tres puertos

| Puerto              | Qué decide                  | De Nova                 |
| ------------------- | --------------------------- | ----------------------- |
| `ErrorCatalog`      | el código y el mensaje      | `NovaErrorCatalog`      |
| `ErrorStatusMapper` | el HTTP de cada capa y tipo | `NovaErrorStatusMapper` |
| `ErrorSerializer`   | el cuerpo y las cabeceras   | `NovaErrorSerializer`   |

Un servicio o un perfil de organización reemplaza el que necesite, sin forkear
Nova; los que no declara quedan con los de Nova:

```ts
import type { ErrorCatalog } from '@ahincho/nova-nestjs/errors';

const organizationCatalog: ErrorCatalog = {
  describe: (error, status) => ({
    code: status >= 500 ? 'ERROR_INTERNO' : (error.code ?? `HTTP_${status}`),
    message: status >= 500 ? 'Ocurrió un error' : error.message,
  }),
};

NovaModule.forRoot({ errors: { catalog: organizationCatalog } });
```

`ErrorStatusMapper` sólo se consulta para los errores de Nova: una excepción del
framework ya trae su status. Sin catálogo propio, `apiStandard.internalErrorMessage`
sigue siendo el mensaje de todo 5xx.

Otro formato de cuerpo es otro `ErrorSerializer`, como RFC 7807. El `Content-Type`
viaja en las cabeceras que devuelve, y el status y el código llegan ya decididos
en `reply`:

```ts
import type { ErrorSerializer } from '@ahincho/nova-nestjs/errors';

const problemDetails: ErrorSerializer = {
  serialize: (_error, reply) => ({
    headers: { 'Content-Type': 'application/problem+json' },
    body: {
      type: 'about:blank',
      title: reply.code,
      status: reply.status,
      detail: reply.message,
      traceId: reply.traceId,
    },
  }),
};

NovaModule.forRoot({ errors: { serializer: problemDetails } });
```

**La regla del 5xx pasa a ser de quien escribe el puerto.** El error que reciben
los puertos trae lo que va sólo al log -`upstream`, `cause` y el mensaje real de
una falla interna-, y con los puertos de Nova ese detalle nunca sale en un 5xx.
Un catálogo o un serializador propio que lo escriba en el cuerpo rompe la regla
que existe para no contarle la topología al cliente. Para un 5xx conviene tomar
el código y el mensaje de `reply`, que ya vienen decididos por el catálogo, y no
leerlos del error.

## Lo que no hay

**Un contador `nova.errors`.** ADR-031 lo pide en el registro de métricas del
servicio, si lo tiene, y el núcleo NestJS todavía no tiene ninguno (ADR-032).
Mientras tanto, `layer` y `code` son campos de cada línea de log, y se cuentan
desde ahí.
