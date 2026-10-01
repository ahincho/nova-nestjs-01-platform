---
'@ahincho/nova-nestjs': minor
'@ahincho/nova-nestjs-schematics': minor
'@ahincho/nova-nestjs-toolchain': minor
---

El stack va en `err` y el mensaje de una línea de error agrupa

La misma prueba en vivo mostró que el filtro de errores ponía el stack entero en
`msg`, así que cada línea era distinta y agrupar por mensaje dejaba de servir
justo para los errores. Venía de antes de esta versión, igual que lo demás.

- El filtro escribe con la forma de pino: el mensaje es el de la excepción, sin
  el stack, y en un 5xx el error va en `err`. La línea de un 4xx ahora trae
  mensaje, y sigue sin stack.
- `err` tiene siempre la misma forma: `type`, `message` y `stack`, con las
  causas encadenadas, y `code` como texto. El resto de las propiedades
  enumerables del error ya no llega al log: el `response` de una
  `HttpException`, que en unas es texto y en otras objeto, hacía que el índice
  rechazara líneas enteras, y el `body` de un `UpstreamHttpError` es el cuerpo
  de error del upstream.
- La línea de la petición de un 5xx ya no trae el `err` que inventa pino-http,
  con un stack que apuntaba a su propio código.
- La sonda de readiness lleva el chequeo y el motivo como campos,
  `readiness.check` y `readiness.message`, con un mensaje fijo.
