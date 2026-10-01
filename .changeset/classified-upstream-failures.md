---
'@ahincho/nova-nestjs': minor
'@ahincho/nova-nestjs-schematics': minor
'@ahincho/nova-nestjs-toolchain': minor
---

Los fallos de upstream salen clasificados, y el transporte se puede reemplazar

Hasta ahora el cliente HTTP distinguía dos cosas: su propio timeout, que era un
504, y todo lo demás, que era el mismo 502. Se provocó cada fallo contra un
servidor real y undici deja un código distinto para cada uno; la diferencia se
perdía en el stack. Es ADR-035.

**Todo fallo sale como `UpstreamException`**, con un tipo del registro de
RFC 9209 y una categoría que dice de quién es el problema: `connectivity`,
`timeout`, `network`, `response`, `contract` o `internal`. Es una
`HttpException`, así que un servicio que no la atrapa contesta lo correcto sin
tocar nada, y el cuerpo sigue saliendo con el mensaje genérico.

**El log lleva la clasificación como campos**, en un objeto `upstream`, tanto en
la línea del cliente como en la del filtro de errores. Un tablero cuenta por
`upstream.category` sin parsear texto.

**Cambios de comportamiento**:

- Los timeouts de conexión y de DNS pasan de 502 a 504, como recomienda el RFC.
- Un upstream que corta la respuesta a mitad del cuerpo es un 502. Antes era un
  500 sin clasificar, contado como defecto propio.
- Un 2xx cuyo cuerpo no es JSON falla con 502 `http_response_content_invalid`.
  Antes se devolvía el texto como si fuera el tipo pedido. Con `forwardError`, el
  cuerpo de un error sigue llegando como texto.
- Quien atrapaba `BadGatewayException` o `GatewayTimeoutException` del cliente
  ahora recibe `UpstreamException`, con el status en `getStatus()`.

**El transporte es un proveedor**, `NOVA_HTTP_TRANSPORT`. El cliente no usa el
`fetch` global, así que una prueba que asignaba `global.fetch` ya no interceptaba
nada; ahora lo reemplaza con
`overrideProvider(NOVA_HTTP_TRANSPORT).useValue(fetchMock)`, con el mismo
contrato que tenía el `fetch` global.
