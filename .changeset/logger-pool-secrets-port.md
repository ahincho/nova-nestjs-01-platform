---
'@ahincho/nova-nestjs': minor
'@ahincho/nova-nestjs-schematics': minor
'@ahincho/nova-nestjs-toolchain': minor
---

La plataforma monta el logger, el pool de conexiones y el desdoblado de secretos

Cuatro piezas que cada servicio venía resolviendo por su cuenta, o no resolviendo.

**El logger viene montado.** `nestjs-pino` es ahora una dependencia real del core,
`NovaModule.forRoot()` lo levanta y `bootstrap()` lo instala, así que un
`new Logger('X')` de `@nestjs/common` ya escribe JSON estructurado. Antes la
plataforma ofrecía las opciones y dejaba el montaje a cada servicio, y ni el
ejemplo ni el servicio generado lo hacían: salían con el logger de texto plano de
Nest, o sea con líneas que llegan al índice de logs y no aparecen en ninguna
consulta. Se apaga con `observability: { logger: false }`.

El id de correlación dejó de depender del orden de los middlewares: `genReqId`
lee la cabecera, y el contexto adopta un `req.id` que ya esté puesto en vez de
generar otro.

**El filtro de excepciones renombró dos campos**, `requestId` a `traceId` y
`status` a `statusCode`, que son los nombres por los que están escritas las
consultas y los tableros del índice.

**El cliente HTTP tiene pool.** Todas las llamadas salientes comparten un `Agent`
de undici que se cierra ordenadamente al apagar. Medido: doce llamadas
concurrentes usan doce sockets sin pool y dos con `connections: 2`. El cliente
pasó a usar el `fetch` de undici y no el global, porque el de Node rechaza un
despachador del paquete. Se apaga con `pool: false`, y una llamada puede traer su
propio `dispatcher`.

**`bootstrap()` desdobla los secretos inyectados**, antes de que exista la
aplicación. No lleva ninguna lista de nombres: descubre por el prefijo que
declara el perfil de la organización, acepta nombres propios, y `NOVA_SECRETS`
permite agregar uno desde la task definition sin tocar el código. Un secreto
ausente no falla; uno malformado corta el arranque nombrando la variable y nunca
su contenido.

**El puerto se puede leer de otra variable**, con `portVariables` o desde el
perfil: la que inyecta la task definition, que operaciones puede mover sin tocar
la imagen.
