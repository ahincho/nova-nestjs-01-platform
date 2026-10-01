---
'@ahincho/nova-nestjs': minor
'@ahincho/nova-nestjs-schematics': minor
'@ahincho/nova-nestjs-toolchain': minor
---

El id de correlación entra por el borde con su propio nombre, y la identidad la escribe sólo la autenticación

Nova usaba una sola cabecera para tres cosas: leía el id de la primera de
`correlationHeaders`, lo devolvía con ese nombre y lo reenviaba con ese mismo
nombre. Un frontend que lo manda como `transaction-id` no tenía cómo entrar sin
que todos los servicios de adentro cambiaran también. Es ADR-037.

- `observability.requestId.accept`: de qué cabeceras se toma el id del llamador,
  en orden. Por defecto, la cabecera con la que viaja, que es lo de antes.
- `observability.requestId.echo`: con qué nombre se devuelve. Por defecto, la
  primera de `accept`.
- Hacia los upstreams el id sigue viajando con la primera de
  `correlationHeaders`, y es el mismo valor en el log y en el cuerpo de un error.
  El logger lee las mismas cabeceras en el mismo orden: `requestIdHeader` acepta
  ahora una lista.
- Con `bootstrap({ cors })`, CORS permite las cabeceras de `accept` y expone la
  de `echo` sin declararlas aparte. `buildCorsOptions` recibe esas cabeceras como
  segundo parámetro opcional.
- `auth.roleHeader`: con qué cabecera viaja el rol hacia los upstreams. Sin
  default: el rol no viaja si nadie lo pide.

**Corrección de seguridad.** Cuando un servicio declara `auth`, las cabeceras que
escribe la autenticación -la del usuario y, si se declaró, la del rol- ya no se
copian de la petición que llega, en ninguna ruta. Antes, una ruta `@Public()`
reenviaba hacia adentro el `x-user-id` que mandara el cliente, porque está entre
las cabeceras de correlación por defecto y el guard terminaba antes de
reescribirlo. Un servicio que dependía de eso deja de propagarlo; uno que confía
en una identidad escrita por un gateway no declara `auth`, y la sigue copiando.

Una cabecera de correlación que llega vacía ahora se trata como ausente: antes un
`x-request-id` vacío daba un id vacío, que correlaciona todo con todo.
