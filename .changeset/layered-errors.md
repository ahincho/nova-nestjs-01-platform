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
  como `metadata.traceId` y al log como campo, junto a `layer`, `type`, `code` y `upstream`.
- **`NovaModule.forRoot({ errors: { catalog, statusMapper, serializer } })`** reemplaza cualquiera
  de los tres puertos; los que no se declaran quedan con los de Nova.

Lo que ya existía sigue contestando el mismo status: una `HttpException` conserva su status, su
`errorCode` y su mensaje, y se lee como `application` si es un 4xx.

Tres cambios que un cliente puede ver:

- **Los 502, 503 y 504 tienen código propio**: `BAD_GATEWAY`, `SERVICE_UNAVAILABLE` y
  `GATEWAY_TIMEOUT`, en vez de `INTERNAL_SERVER_ERROR`. Es el catálogo de ADR-031, y le dice al
  cliente si conviene reintentar sin nombrar al proveedor. `@ApiErrors()` documenta lo mismo. Un
  cliente o un test que comparaba esos 5xx contra `INTERNAL_SERVER_ERROR` tiene que actualizarse.
- **Toda respuesta de error trae `metadata: { traceId }`.** Es aditivo, y un éxito no cambia; un
  test que compara el cuerpo de un error con igualdad exacta tiene que sumarla.
- **Un `UpstreamHttpError` que se deja escapar sale como 502, o 504 si el upstream tardó**, y ya no
  como 500. Y un error que dice cuánto esperar lleva la cabecera `Retry-After`, en segundos.

La línea de log del filtro cambia de forma: los campos son los de arriba más `status`, `message`,
`requestId`, `method` y `path`, y deja de llevar `errors`.

No hay contador `nova.errors`: ADR-031 lo pide en el registro de métricas del servicio, y el núcleo
todavía no tiene ninguno.
