---
'@ahincho/nova-nestjs': minor
---

**Errores por capa, con trazabilidad (ADR-031).** Quien lanza dice qué pasó, y la plataforma decide
el HTTP, el código y el cuerpo.

```ts
import { DomainError } from '@ahincho/nova-nestjs/errors';

throw DomainError.notFound('Pedido no encontrado', { code: 'ORDER_NOT_FOUND' });
```

- **El subpath `@ahincho/nova-nestjs/errors` no carga Nest.** Trae `Layer`; una clase por capa,
  que son `DomainError`, `ApplicationError`, `InfrastructureError` y `PlatformError`, cada una con
  su tipo enumerado y una fábrica por tipo; y los tres puertos con su implementación de Nova:
  `ErrorCatalog`, `ErrorStatusMapper` y `ErrorSerializer`. Una regla de oxlint y un test que sigue
  el grafo de imports verifican que siga sin framework.
- **El `traceId` se toma al construir el error**, del contexto de la petición, y llega al cuerpo
  como `metadata.traceId` y al log como campo, junto a `layer`, `type`, `code` y `upstream`. Si ni
  el error ni la petición traen uno -un cuerpo JSON que no se puede leer falla antes de que el
  middleware abra el contexto-, el filtro genera uno: un error nunca sale sin algo que citar.
- **`NovaModule.forRoot({ errors: { catalog, statusMapper, serializer } })`** reemplaza cualquiera
  de los tres puertos; los que no se declaran quedan con los de Nova.
- **El nivel del log lo decide la capa.** `domain` y `application` son esperados y van en `warn`,
  sin stack; `infrastructure` y `platform` son incidentes y van en `error`, con la causa completa.

Lo que ya existía sigue contestando el mismo status: una `HttpException` conserva su status, su
`errorCode` y su mensaje, y se lee por su status. Un 4xx es `application`, un 502, 503 o 504 es
`infrastructure` y otro 5xx es `platform`.

**Cambios incompatibles que un cliente puede ver**, y por eso es un minor y no un patch:

- **Los 502, 503 y 504 tienen código propio**: `BAD_GATEWAY`, `SERVICE_UNAVAILABLE` y
  `GATEWAY_TIMEOUT`, en vez de `INTERNAL_SERVER_ERROR`. Es el catálogo de ADR-031, y le dice al
  cliente si conviene reintentar sin nombrar al proveedor. `@ApiErrors()` documenta lo mismo. Un
  cliente o un test que comparaba esos 5xx contra `INTERNAL_SERVER_ERROR` tiene que actualizarse.
- **Un `UpstreamHttpError` que se deja escapar sale como 504 si el upstream contestó 504 o 408, y
  como 502 con cualquier otra cosa**, y ya no como 500. Es lo mismo que contesta el cliente HTTP
  cuando no se le pide el error crudo.
- **La línea de log del filtro cambia de forma.** Los campos son `traceId`, `layer`, `type`, `code`
  y, si hay, `upstream`, más `status`, `message`, `requestId`, `method` y `path`, y `fieldErrors`
  cuando el error los trae. Deja de llevar `errors`, así que una consulta o un tablero escrito
  contra ese campo tiene que moverse a `code` y `layer`.

Y dos cambios que suman sin quitar nada:

- **Toda respuesta de error trae `metadata: { traceId }`.** Un éxito no cambia, pero un test que
  compara el cuerpo de un error con igualdad exacta tiene que sumarla.
- **Un error que dice cuánto esperar lleva la cabecera `Retry-After`, en segundos.**

No hay contador `nova.errors`: ADR-031 lo pide en el registro de métricas del servicio, si lo tiene,
y el núcleo todavía no tiene ninguno.
