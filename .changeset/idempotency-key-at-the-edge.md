---
'@ahincho/nova-nestjs': minor
---

La clave de idempotencia cruza el BFF

Es la parte de NestJS de ADR-047. El BFF no tiene estado y no aplica la
idempotencia: la aplica el servicio que tiene los datos, como pedidos en Plaza. Lo
que le toca al BFF es dejarla pasar.

- **CORS permite `Idempotency-Key`**, así que un navegador puede reintentar una
  compra con su clave, y **expone `Idempotent-Replayed` y `Retry-After`**, para que
  el script sepa si la respuesta es una repetida y cuánto esperar ante un 409.
- **El cliente HTTP propaga `idempotency-key`** a los upstreams, como ya hacía con
  `x-request-id`: se suma a `DEFAULT_CORRELATION_HEADERS`, y solo viaja si el
  llamador la mandó.

**Para tener en cuenta:** una lista propia en `correlationHeaders` reemplaza la de
Nova entera, así que tiene que sumar `idempotency-key` para propagarla. Y como la
clave viaja a cada upstream, un handler que llama a dos rutas con `@Idempotent`
del mismo servicio recibe un 422 en la segunda: una clave es de una sola operación.
