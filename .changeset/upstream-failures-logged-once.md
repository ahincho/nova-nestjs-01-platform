---
'@ahincho/nova-nestjs': minor
'@ahincho/nova-nestjs-schematics': minor
'@ahincho/nova-nestjs-toolchain': minor
---

Cada fallo de upstream deja una sola línea de error, la del filtro

Una prueba en vivo contra un upstream caído mostró dos líneas de error por cada
fallo, con los mismos campos: la de `HttpClientService` y la del filtro de
errores. Todo conteo por categoría daba el doble. Venía de antes de esta
versión.

- `HttpClientService` ya no registra los fallos: lanza, y la excepción lleva los
  campos. El filtro deja la única línea, con `upstream` -la clasificación- y
  `outbound` -el método, la URL sin query y el plazo-. Un fallo que el llamador
  atrapa para degradar la respuesta lo registra el llamador, con
  `error.logFields`.
- Tampoco registra el error pedido con `forwardError`, que salía en `error`
  aunque el llamador lo tradujera a un 404.
- El aviso de las cabeceras propagadas lleva la causa en `err`, no pegada al
  mensaje.

**`UpstreamHttpError` es ahora una `UpstreamException`.** El patrón de siempre
-traducir el status que se entiende y relanzar el resto- convertía lo relanzado
en un 500, porque el filtro veía un `Error` suelto. Ahora sale como sin
`forwardError`: 502 o 504, clasificado. Quien la distinguía con
`instanceof HttpException` la encuentra ahora de ese lado.

Un tablero o una alerta escritos sobre las líneas de `HttpClientService` tienen
que pasar a las del filtro, `context: AllExceptionsFilter`, que traen los mismos
campos.
