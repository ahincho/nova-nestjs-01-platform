# @ahincho/nova-nestjs

## 0.16.0

### Minor Changes

- c75629e: Los fallos de upstream salen clasificados, y el transporte se puede reemplazar

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

- 116bce0: El id de correlación entra por el borde con su propio nombre, y la identidad la escribe sólo la autenticación

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

- f72d3be: La clave de idempotencia cruza el BFF

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

- 6189700: **Errores por capa, con trazabilidad (ADR-031).** Quien lanza dice qué pasó, y la plataforma decide
  el HTTP, el código y el cuerpo.

  ```ts
  import { DomainError } from '@ahincho/nova-nestjs/errors';

  throw DomainError.notFound('Pedido no encontrado', {
    code: 'ORDER_NOT_FOUND',
  });
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

- ee854b3: La plataforma monta el logger, el pool de conexiones y el desdoblado de secretos

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

- d9570f4: Perfiles de organización, y defaults que ya no son de nadie en particular

  Varios defaults del núcleo eran las convenciones de una organización: el puerto
  que salía primero de `APP_PORT`, los roles de `realm_access.roles`, el
  identificador en mayúsculas, el prefijo de los secretos. Para cualquier otra eran
  defaults equivocados que había que deshacer servicio por servicio. Es ADR-036.

  **Un perfil declara las convenciones de una organización una sola vez**, en su
  propio paquete:

  ```ts
  export const acme = defineProfile({
    name: 'acme',
    bootstrap: {
      portVariables: ['APP_PORT', 'PORT'],
      secrets: { prefix: 'CREDENTIALS_' },
    },
    auth: { rolesClaim: 'realm_access.roles' },
  });

  NovaModule.forRoot({ profile: acme });
  void bootstrap(AppModule, { profile: acme });
  ```

  El orden es fijo -defaults de Nova, perfil, servicio- y el servicio sigue
  pudiendo cambiar cualquier cosa. Un perfil no enciende la autenticación ni toca
  una regla del núcleo. Si `NovaModule` y `bootstrap()` reciben perfiles
  distintos, el arranque corta.

  **Cambios incompatibles**, que un servicio recupera declarando esos valores en
  su perfil:

  - El puerto sale de `PORT`. `APP_PORT` ya no se lee sin que alguien la declare.
  - `secrets` no trae prefijo: `true` sin perfil sólo lee `NOVA_SECRETS`.
    `DEFAULT_SECRET_PREFIX` deja de existir.
  - Los roles salen de `roles`, el claim de RFC 9068, y no se descarta ningún rol
    técnico. Un token de Keycloak necesita `rolesClaim: 'realm_access.roles'`.
  - El identificador del usuario sólo pierde los espacios de los bordes.
    `normalizeUserId`, que quitaba la arroba y pasaba a mayúsculas, sigue
    existiendo para declararlo en un perfil.

  El identificador sigue saliendo de `preferred_username`, que es un claim
  estándar de OpenID Connect y no de un proveedor.

- 0f7c29c: El estándar de API se puede reemplazar sin apagar sus reglas

  Hasta ahora la única forma de contestar con otro cuerpo era apagar el
  interceptor y el filtro, y apagarlos se llevaba las reglas: el saneado del 5xx,
  el caso que no es HTTP, `@SkipResponseWrapper()`. El servicio las tenía que
  reescribir, y cualquiera de las tres se podía olvidar. Es ADR-034.

  **El estándar es un puerto.** `ApiStandard` dice cómo se ve una respuesta
  exitosa, un error y su documentación, y `NovaEnvelopeStandard` -el sobre de
  siempre- es la implementación que se registra cuando nadie declara otra:

  ```ts
  NovaModule.forRoot({ apiStandard: { standard: OrgStandard } });
  ```

  **Un servicio que no declara nada contesta igual que antes**: las pruebas del
  sobre pasan sin tocarlas, y el documento OpenAPI se comparó contra el que
  generaba 0.15.0 y es idéntico, hasta en el orden de las claves.

  **El estándar decide la forma; la plataforma decide qué se puede decir.** El
  estándar no recibe la excepción sino un fallo ya clasificado y saneado, así que
  no tiene de dónde filtrar el mensaje de un 5xx ni su código de dominio. Qué
  respuestas pasan por él y qué se valida en la entrada tampoco cambian.

  **La entrada pasa por el mismo estándar.** `ValidationException` lleva
  `violations`, neutras -campo y mensaje-, y el catálogo del estándar activo les
  pone nombre. `validationErrors` sigue funcionando, deprecada.

  **Cambiar sólo los códigos no pide escribir un estándar**:
  `new NovaEnvelopeStandard({ codes: { byStatus: { 502: 'BAD_GATEWAY' } } })`. Se
  suman al catálogo de Nova en vez de reemplazarlo.

  **`@ApiEnvelope` y `@ApiErrors` documentan el estándar activo.** Corren antes de
  que exista la inyección, así que dejan una marca que `setupOpenApi` resuelve al
  armar el documento; con otro estándar, el sobre de Nova ni aparece.

  `wrapResponses` y `catchExceptions` quedan deprecadas. No se rompe nada: siguen
  funcionando igual.

- e85f82d: Los secretos de un almacén: Vault y AWS Secrets Manager

  Un servicio ya no solo desdobla el JSON que la plataforma inyecta en el entorno:
  también puede leer sus secretos de un almacén al arrancar, antes de que exista
  la aplicación (ADR-049).

  ```ts
  void bootstrap(AppModule, { secrets: { imports: ['vault:plaza-bff'] } });
  ```

  O desde la task definition, con `NOVA_SECRETS_IMPORT=vault:plaza-bff`. Es la
  misma forma y la misma variable que en Spring Boot y en Quarkus: quien opera un
  servicio pide un almacén igual sin saber en qué framework está escrito.

  **Dos paquetes nuevos**, uno por almacén, para que un servicio que usa Vault no
  instale el SDK de AWS: `@ahincho/nova-nestjs-secrets-vault` y
  `@ahincho/nova-nestjs-secrets-aws-secrets-manager`. El servicio no registra
  ninguno: `vault:` hace que la plataforma lo cargue desde sus dependencias, y si
  no está instalado el arranque corta diciendo cuál instalar.

  **Las reglas son las de Java.** Un secreto obligatorio que no existe corta el
  arranque, salvo con `optional:`; cada llamada lleva timeout y no se reintenta;
  ningún error cita el contenido; un pedido gana sobre lo que se desdobla del
  entorno, y entre dos gana el último. La configuración lleva los mismos nombres
  que en Java, escritos como variables: `NOVA_SECRETS_VAULT_ADDRESS`, que cae a
  `VAULT_ADDR`, o `NOVA_SECRETS_AWS_SECRETS_MANAGER_REGION`.

  **Un pedido se lee aunque el servicio no declare nada**, porque es explícito.
  Un servicio que hoy tiene `NOVA_SECRETS_IMPORT` puesta sin querer va a cortar el
  arranque si no instaló el almacén; `secrets: false` apaga todo.

  El core exporta el contrato para escribir otro almacén: `SecretSourceProvider`,
  `SecretSource`, `secretFromJson`, `durationSetting` y `SecretSourceError`.

- e2c1140: El stack va en `err` y el mensaje de una línea de error agrupa

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

- 8448f01: Cada fallo de upstream deja una sola línea de error, la del filtro

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

## 0.15.0

### Patch Changes

- dd9b26c: La ventana de apagado decía servir para algo que no hace.

  `gracefulShutdownTimeoutMs` estaba documentado -en la opción, en `health.md`, en la plantilla del
  generador- como el mecanismo que le da tiempo al balanceador a sacar la tarea de rotación, y como
  un valor que conviene **mayor al intervalo de la sonda**.

  Las dos cosas son falsas. En ECS el orden es al revés: primero se desregistra el target, después
  se espera el _deregistration delay_, y sólo entonces llega el SIGTERM; cuando el proceso se
  entera, el balanceador ya dejó de mandarle tráfico. Y los target groups de A303 tienen
  `HealthCheckIntervalSeconds: 60`, así que no hay valor razonable que cumpla esa regla: los 5000 ms
  que trae el generador son doce veces menores.

  El valor está bien, la explicación no. La ventana sirve para que las peticiones **en vuelo**
  terminen, y se dimensiona por eso: mayor que la petición más lenta que valga la pena esperar, y
  menor que el `stopTimeout` de la tarea -30 s por defecto-, porque pasado ese plazo llega un
  SIGKILL a mitad del drenaje.

## 0.14.1

### Patch Changes

- 6dc3afb: El release empuja sus tags, y falla si no publicó nada.

  Dos defectos del workflow de release que salieron al publicar la 0.14.0:

  - **Ningún release había etiquetado nada.** Veintiún versiones publicadas sin que quedara en
    git una sola marca de qué commit produjo cada una. Se recuperaron los 55 tags a partir del
    SHA de cada corrida de release.

    Corrección posterior a la 0.14.1: esta nota culpaba a `git push --follow-tags` por empujar
    sólo tags anotados mientras changesets creaba lightweight. Es al revés. changesets los crea
    **anotados a propósito** -su código comenta que si no, `--follow-tags` no los empujaría-, y
    un tag anotado exige identidad de committer. El job de release no configuraba ninguna, así
    que `git tag -m` salía con 128 y changesets no se enteraba: imprime «New tag: X» antes de
    llamar a git y descarta el resultado.

  - **Una corrida podía publicar nada y quedar verde.** `changeset publish` publica lo que dicen
    los manifiestos: sin el commit de `version-packages` en la rama, termina bien sin subir nada.
    Ahora el paso lee la línea que changesets imprime cuando publicó algo, y corta si no
    aparece.

    Corrección posterior a la 0.14.1: esta nota decía que había pasado seis veces. No hay
    evidencia de eso -el conteo salió de cruzar las corridas contra los tres nombres de
    paquete actuales, y las primeras publicaban el juego de once que ya no existe-. La
    trampa es real como mecanismo; el historial que se le atribuía, no.

## 0.14.0

## 0.13.0

### Minor Changes

- da8a5bf: **Una sola imagen para los tres ambientes.** El ambiente llega por variable de entorno en tiempo de
  ejecución; nada se hornea al construir.

  `appEnvironment()` lee `NODE_ENV` y devuelve `'development' | 'qa' | 'production'`. Los valores son
  los que inyectan las task definitions de verdad -`development` en el bloque `dev:` y `qa` en el
  `qa:`, en los siete BFF-, no una convención inventada.

  Sin inyectar nada cae en `production`, que es el más restrictivo: un contenedor que nadie configuró
  no publica su documentación en vez de abrirse. Pero **no acepta cualquier cosa**: un `NODE_ENV=dev`
  mal escrito no es «algo que no es producción», es una task definition rota, y el contenedor lo dice
  al arrancar.

  Probado con una sola imagen y cinco contenedores:

  ```
  (sin NODE_ENV)         health 200   docs 404
  NODE_ENV=development   health 200   docs 200
  NODE_ENV=qa            health 200   docs 200
  NODE_ENV=production    health 200   docs 404
  NODE_ENV=dev           EnvironmentError: must be one of development, qa, production, but was "dev"
  ```

  Vale saber la contrapartida de usar `NODE_ENV` para esto: en qa vale `qa`, así que todo lo que
  ramifica sobre `NODE_ENV === 'production'` corre en modo desarrollo ahí.

  El servicio generado lo usa para decidir si publica su documentación, y `.env.example` documenta la
  variable. Reemplaza a `OPENAPI_ENABLED`.

  ### Y la imagen se construye más rápido

  La etapa `deps` copia sólo los manifiestos, así que cambiar una línea de `src/` ya no reinstala
  nada: **de 23s a 14s** reconstruyendo tras tocar `main.ts`.

  Antes esto rompía las dependencias `file:` -necesitan su archivo en el contexto y no aparecen en
  ningún manifiesto- y el `.npmrc`, que el arnés de CI borra a propósito. Los dos entran ahora con un
  comodín que no falla cuando el archivo no está.

  Además:

  - **`NODE_IMAGE` como ARG**, para poder fijar la base por digest sin perder la variable de versión:
    `nova docker --build-arg NODE_IMAGE=node@sha256:...`. Un tag es móvil, así que dos builds del
    mismo commit pueden dar imágenes distintas.
  - **`test/` sale del contexto**, así que cambiar un spec ya no invalida la capa de compilación.
  - **CI exporta la cache de BuildKit** (`type=gha`). Vivía en el runner, y el runner se destruye: sin
    eso cada build de CI era frío.

## 0.12.1

## 0.12.0

### Minor Changes

- 40c6d5a: Agrega OpenAPI, la imagen de contenedor compartida y el binario de los generadores.

  **OpenAPI.** `bootstrap({ openapi: { title } })` publica el documento en `/docs/json` y su interfaz
  en `/docs`. Omitir la opción no publica nada, igual que con CORS y con `auth`: exponer la
  documentación es una decisión de quien despliega.

  La parte que un `@nestjs/swagger` suelto no puede resolver es el sobre. El interceptor envuelve la
  respuesta **después** de que el controlador la devolvió, así que un documento generado del tipo de
  retorno describe el método y no el cable, y un cliente generado de ahí no compila contra el
  servicio. `ApiEnvelope(Dto)` y `ApiErrors(404)` cierran esa distancia, y el código de error de cada
  fallo sale de `statusToErrorCode`, la misma función que usa el filtro de excepciones en ejecución.

  El requisito del token va en la raíz del documento y no operación por operación, porque el guard de
  `NovaAuthModule` también es global: un decorador por método dejaría documentado como abierto todo lo
  que alguien olvidó anotar.

  **La imagen.** `nova docker` construye con un Dockerfile que vive en el toolchain y se usa con
  `-f`, así que es el mismo para todos los servicios. Cuatro etapas, sin pnpm ni código fuente en la
  final, corriendo como el usuario `node`. El token del registry entra como secreto de BuildKit
  -montado, no copiado: un `ARG` queda en el historial de la imagen-. Lo que varía por servicio va
  como `ARG`. Para un pipeline que exige el archivo en la raíz está `nova docker --eject`.

  **El binario.** `pnpm dlx @ahincho/nova-nestjs-schematics service academic-acl` ahora funciona sin
  instalar nada. Antes no había forma cómoda de crear el primer servicio: `nest g -c` necesita un
  proyecto que todavía no existe, y `pnpm dlx` cortaba con `ERR_PNPM_DLX_NO_BIN`.

  **El servicio generado** nace con los dos: `openapi` en su `main.ts` -apagable con
  `OPENAPI_ENABLED`-, un test que pide `/docs/json`, un `.dockerignore` y el script `nova docker`.

  **Al actualizar hay que agregar una línea.** `@nestjs/swagger` arrastra `@scarf/scarf`, cuyo script
  de instalación es telemetría, y pnpm **aborta el install** cuando hay un script sin decidir. Un
  servicio que ya existe falla en `pnpm install` -antes de compilar nada- hasta que su
  `pnpm-workspace.yaml` diga:

  ```yaml
  allowBuilds:
    '@scarf/scarf': false
  ```

  Los servicios nuevos ya nacen con esa línea. Apagarlo no le quita nada: la documentación se sirve
  igual.

## 0.11.1

### Patch Changes

- Corrige el idioma de las reglas de arquitectura que genera el schematic, y las tildes de los
  comentarios.

  **Los 14 `name` de `.dependency-cruiser.js` estaban en español** -`service-no-importa-adapter`-
  copiados tal cual de los templates de donde salió esta forma. Un `name` es un identificador:
  aparece en la salida y es la clave con la que un baseline de `--ignore-known` referencia la
  regla, así que va en inglés. Ahora son `service-must-not-import-adapter`,
  `context-must-not-import-another-context`, `feature-uses-only-the-upstream-port` y así.

  El `comment` de cada regla se queda en español, porque es lo que lee una persona cuando la regla
  salta. Eso no cambia.

  **Y las tildes.** Los comentarios en español las llevan, y se habían perdido en 11 archivos
  \-`nova.mjs`, el preset de Vitest, la configuración de oxlint, el script del chequeo de
  consumidor, el generador y sus plantillas-. Restituidas, revisando a mano los casos que un
  reemplazo automático se equivoca: `quien` relativo no lleva tilde y `quién` interrogativo sí.

  Sólo cambia texto: ningún comportamiento.

## 0.11.0

### Minor Changes

- Agrega el generador de servicio y `nova lint:arch`.

  ```bash
  pnpm dlx @ahincho/nova-nestjs-schematics service academic-acl
  cd academic-acl && pnpm install && pnpm verify
  ```

  Deja un servicio que arranca y **pasa su propia puerta de calidad**: los tres paquetes de la
  plataforma y nada más, el `publicHoistPattern`, los dos `tsconfig`, el `nest-cli.json`, el
  `.oxlintrc.json`, el `vitest.config.mjs`, `bootstrap()`, `NovaModule.forRoot()`, un test de las
  sondas y las reglas de arquitectura. Con `--style=bff` o `--style=acl`, la misma distinción que
  ya hace `feature`.

  **Lo que no genera es el argumento del paquete: no hay `src/common/` ni `src/core/`.** El filtro
  global, el interceptor del sobre, las sondas, el cliente HTTP, la configuración, el contexto de
  petición y el logger llegan dentro de `@ahincho/nova-nestjs`. Medido sobre los templates de los
  que sale esta forma, esas dos carpetas eran **el 50 % de `src` en un BFF y el 40 % en un ACL**.

  **`nova lint:arch`** corre `dependency-cruiser`, que entra al toolchain. Es la única puerta que
  oxlint no puede cubrir: su `no-restricted-imports` filtra por el especificador y no por dónde
  está el archivo que importa, así que no sabe decir «el service no importa el adapter, pero el
  module sí». Va dentro de `nova verify`.

  **Las reglas generadas no enumeran contextos a mano**, usan un comodín. Una regla que los lista
  uno por uno sigue en verde cuando aparece el siguiente, y nadie se entera de que dejó de mirarlo.

  Dos arreglos que salieron de generar y correr el servicio de verdad:

  - `nova` resolvía los binarios con `require.resolve`, que no alcanza a un paquete cuyo `exports`
    declara sólo la condición `import` -es el caso de `dependency-cruiser`- ni a uno que no exporta
    su propio `package.json`. Ahora usa `import.meta.resolve` y, si hace falta, sube desde la
    entrada hasta el manifiesto.
  - El generador normaliza los finales de línea a LF: el motor de plantillas del DevKit devuelve
    CRLF en Windows, y el servicio recién generado no pasaba su propio `format:check`.

  No genera `Dockerfile`: la imagen base, el usuario y el puerto dependen de dónde se despliegue.

## 0.10.2

### Patch Changes

- Documenta cómo se comporta de verdad `return503OnClosing`, que estaba descrito de más.

  Decía que durante el apagado «una petición nueva recibe 503», a secas. **Actúa sobre las
  conexiones ya establecidas.** Medido con el cierre disparado en t=1200 ms:

  | Qué                                      | Resultado                   |
  | ---------------------------------------- | --------------------------- |
  | petición en vuelo cuando llega el cierre | **200**, terminó completa   |
  | petición nueva, conexión ya abierta      | **503 Service Unavailable** |
  | petición nueva, conexión TCP nueva       | **ECONNREFUSED**            |

  Una conexión nueva se rechaza antes de que exista una petición HTTP que contestar, porque el
  listener ya dejó de aceptar. Para el caso real es lo correcto -un balanceador mantiene la
  conexión abierta- pero **probarlo con un `curl` suelto muestra el rechazo y no el 503**, y se
  lee como que la opción no funciona.

  Está en `packages/core/docs/health.md`, con la receta de `http.Agent({ keepAlive: true })` que
  hace falta para verlo. Sólo cambia documentación y un comentario.

## 0.10.1

### Patch Changes

- 3f2ae0c: CI y el release ahora instalan los paquetes empaquetados en el servicio de ejemplo antes de
  publicar.

  **El monorepo no puede ver un conflicto de peers**: cada paquete del workspace resuelve su
  propio árbol, así que dos dependencias incompatibles entre paquetes distintos conviven sin
  problema. Un servicio las aplana en uno solo y ahí el install corta. Así salió publicada la
  0.8.0, con `pnpm verify` en verde, y el defecto lo encontró instalar el paquete ya publicado en
  el ejemplo.

  El paso empaqueta los tres, los instala en una copia del servicio de ejemplo y corre allí el
  install, el chequeo de peers, el build y la suite. De paso ejercita el comando `nova`, que
  llega dentro del tarball del toolchain.

  Cuando un release trae un cambio incompatible el chequeo se traba, porque el ejemplo todavía no
  compila contra la versión nueva. Para eso está el input `consumer-ref` del workflow, que apunta
  el chequeo a la rama del ejemplo que ya absorbió el cambio.

## 0.10.0

### Minor Changes

- Agrega `nova start`, que faltaba para que el `package.json` de un servicio no quedara con
  `nova build` al lado de `nest start`.

  ```json
  { "scripts": { "start": "nova start", "start:dev": "nova start --watch" } }
  ```

  **El arranque en producción se queda en `node dist/main`**, escrito a mano. Es el contrato con
  el Dockerfile, no una elección de herramienta que la plataforma deba poder cambiar sola.

## 0.9.0

### Minor Changes

- Agrega el comando `nova` al toolchain, para que los scripts de un servicio dejen de nombrar la
  herramienta.

  ```json
  {
    "scripts": {
      "build": "nova build",
      "test": "nova test",
      "test:cov": "nova test:cov",
      "lint": "nova lint",
      "format": "nova format",
      "format:check": "nova format:check",
      "typecheck": "nova typecheck"
    }
  }
  ```

  `nova build` usa `nest build` si hay un `nest-cli.json` y `tsc -p tsconfig.build.json` si no.
  `nova verify` encadena typecheck, lint, cobertura y formato. Lo que sobre se le pasa tal cual a
  la herramienta.

  **Por qué.** En un solo día la plataforma cambió de runner y de linter, y las dos veces hubo que
  editar el `package.json` de cada consumidor para reemplazar una palabra. El día que oxfmt llegue
  a 1.0, `nova format` cambia en el toolchain y en ningún otro lado.

  **Y una razón que no es comodidad:** `oxlint` sin `--type-aware` no evalúa las 23 reglas que
  necesitan tipos y **no avisa**. Un script escrito a mano puede perder esa bandera sin que nada se
  rompa; dentro del comando no se puede perder.

  **El `publicHoistPattern` del servicio se acorta.** `nova` resuelve cada binario desde el paquete
  del toolchain, así que `oxlint`, `oxlint-tsgolint` y `prettier` salen de la lista: nadie los
  importa, sólo se ejecutan. Siguen `@nestjs/*`, `@types/*`, `typescript`, `vitest` y `supertest`,
  que sí se importan o se resuelven desde el `tsconfig`.

  El monorepo pasa a usarlo también, y con eso el catálogo de `pnpm-workspace.yaml` se reduce a
  `@types/node` y `rimraf`: las versiones de las herramientas viven en las `dependencies` del
  toolchain, que es donde tienen que estar.

  El paquete del toolchain además **se typechequea a sí mismo**. Su script decía «no tiene nada que
  typechequear» y eso ya era falso: publica el comando. Sin un `tsconfig` que lo cubriera,
  `oxlint --type-aware` tampoco conseguía tipos y sus reglas `no-unsafe-*` se disparaban sobre el
  archivo entero.

## 0.8.1

### Patch Changes

- Cierra un choque de peers que 0.8.0 dejó abierto y que sólo se ve desde un servicio.

  `@nestjs/cli` 12 trae `chokidar` 5 y Angular DevKit 22; los schematics declaraban DevKit 20,
  cuyo peer es `chokidar` ^4. En el monorepo no aparece, porque cada paquete resuelve su propio
  árbol; en un servicio los dos caen en el mismo y el install corta con
  `unmet peer chokidar`. Los schematics pasan a DevKit `^22.1.5`, que es el que pide
  `chokidar` ^5.

  Es exactamente para lo que está `strictPeerDependencies`, y lo que lo encontró fue instalar el
  paquete publicado en el servicio de ejemplo. Un `pnpm peers check` sobre el monorepo no basta.

  De paso, el piso de Node sube de `>=24` a `>=24.15`, que es lo que declara Angular DevKit 22
  (`^22.22.3 || ^24.15.0 || >=26.0.0`). Mismo criterio que fijó el ADR-016: el número tiene que
  poder justificarse contra el `engines` de alguna dependencia.

## 0.8.0

### Minor Changes

- Sube la plataforma a NestJS 12.

  **NestJS 12 se publica sólo como ESM**, sin build de CommonJS. La plataforma **sigue siendo
  CommonJS** y lo consume con `require(esm)`, que es el camino que el propio `nest upgrade`
  asume: no migra a ESM. Comprobado compilando y corriendo un módulo con inyección por
  constructor. Requiere Node 22.12 o superior, y el piso ya es 24.

  **Cambio incompatible, de `@nestjs/config` 12: `validationSchema` pasa de Joi a
  [Standard Schema](https://standardschema.dev/)** (Zod, Arktype, valibot). Un servicio que
  traiga un esquema de Joi tiene que cambiarlo. Quien no quiera sumar una librería puede
  omitirlo y validar dentro de sus namespaces, o pasarle `validate` a `ConfigModule`, que es una
  función y no necesita nada instalado. `NovaConfigModuleOptions.validationSchema` deja de ser
  `unknown` y toma el tipo que declara `@nestjs/config`, derivado de su propia interfaz para no
  agregar una dependencia por un tipo.

  Tres cosas nuevas que `bootstrap()` ahora fija:

  - **`routeConflictPolicy: { duplicate: 'error', shadow: 'warn' }`.** Una ruta duplicada -mismo
    método, ruta, host y versión- corta el arranque: uno de los dos manejadores es código muerto
    y cuál gana depende del orden de registro. Una ruta ensombrecida, `/users/me` contra
    `/users/:id`, sólo avisa porque a veces es deliberada. Se puede relajar con la opción
    `routeConflicts`. NestJS trae las dos en `'off'`.
  - **`return503OnClosing: true`**, la otra mitad del apagado ordenado. `enableShutdownHooks`
    avisa a los módulos, pero sin esto el proceso sigue aceptando peticiones nuevas mientras se
    apaga. Ahora una petición nueva recibe 503 -que es lo que el balanceador necesita para sacar
    la tarea de rotación- y las que ya estaban en vuelo terminan.
  - **El filtro global lee `errorCode` de la excepción.** Es lo que deja escribir
    `throw new NotFoundException('Curso no encontrado', { errorCode: 'COURSE_NOT_FOUND' })` en
    vez de una excepción propia por cada código de dominio. Sólo por debajo de 500: un 5xx
    contesta el mensaje genérico a propósito.

  Y una consecuencia del cambio de grafo de módulos: **el preset de Vitest sube el límite por
  test de 5 s a 20 s**. El primer test de cada archivo paga la carga del grafo, que desde
  NestJS 12 es ESM y pesa más -740 ms con la máquina libre, visto pasar de 5 s con el build y
  el lint corriendo antes en la misma pasada-. Se ajusta con la opción `timeoutMs`. Lo que se
  evita no es un test lento sino un fallo intermitente que se lee como un defecto del código.

## 0.7.0

### Minor Changes

- Reemplaza ESLint por oxlint como linter de la plataforma.

  **Cambio incompatible en el toolchain.** El preset
  `@ahincho/nova-nestjs-toolchain/eslint/index.mjs` desaparece y con él `eslint` y
  `typescript-eslint`, que ya no se instalan. En su lugar llegan `oxlint` y
  `oxlint-tsgolint`, y una configuración en JSON:

  ```json
  // .oxlintrc.json
  {
    "extends": [
      "./node_modules/@ahincho/nova-nestjs-toolchain/oxlint/oxlintrc.json"
    ]
  }
  ```

  La ruta va relativa y entra a `node_modules` porque **`extends` de oxlint resuelve rutas de
  archivo, no especificadores de paquete**. Como el toolchain es una dependencia directa del
  servicio, pnpm le deja un enlace real en la raíz de `node_modules`.

  Un servicio que actualice tiene que borrar su `eslint.config.mjs`, escribir ese
  `.oxlintrc.json`, cambiar `"lint"` a `oxlint --type-aware` y reemplazar `eslint` por `oxlint`
  y `oxlint-tsgolint` en su `publicHoistPattern`.

  **`--type-aware` no es opcional.** Las 23 reglas que necesitan tipos sólo corren con esa
  bandera. Sin ella oxlint no avisa: no las evalúa y el reporte sale verde con la mitad del
  análisis sin hacer.

  **Por qué.** Medido sobre un servicio real de 70 archivos con análisis de tipos en los dos
  casos: ESLint 14.4 s contra oxlint 0.75 s, con los mismos 10 hallazgos sobre un archivo de
  prueba. Y `typescript-eslint` rechaza TypeScript 7, mientras que el `tsgolint` de oxlint está
  construido sobre TS 7.

  El monorepo ahora **se lintea a sí mismo**, que antes no hacía: publicaba un preset de linter
  que nunca corría sobre su propio código. La primera pasada encontró siete hallazgos reales,
  corregidos en este mismo cambio; el más serio era un `Array.isArray` sobre un
  `readonly string[]` en `NovaConfigModule.forRoot`, que estrecha a `any[]` y metía un `any` en
  el `envFilePath` que se le pasa a `@nestjs/config`.

### Patch Changes

- 43a915a: Relaja el piso de Node de `>=24.9` a `>=24`.

  El `.9` era exactamente lo que Jest necesitaba para cargar `@nestjs/terminus` 12, que es sólo
  ESM, con `--experimental-vm-modules`. Retirado Jest en 0.6.0, ese número se quedó sin referente.

  Ninguna dependencia del árbol llega a 24.9: `vitest` 5 pide
  `^22.12.0 || ^24.0.0 || >=26.0.0`, terminus 12 pide `^20.19.0 || ^22.12.0 || >=24.0.0` y
  `eslint` 10 pide `^20.19.0 || ^22.13.0 || >=24`. Dentro de la línea 24 el piso real es 24.0.0.

  Node 24 sigue siendo el objetivo por razones propias: es LTS, es lo que corren las imágenes de
  los servicios y es lo que corre A303. Ver ADR-016 en `ahincho/nova-docs`.

## 0.6.0

### Minor Changes

- c639fc6: Reemplaza Jest por Vitest como runner de tests de la plataforma.

  **Cambio incompatible en el toolchain.** El preset
  `@ahincho/nova-nestjs-toolchain/jest` desaparece y con él `jest`, `ts-jest` y
  `@types/jest`, que ya no se instalan. En su lugar llega `vitest` con
  `@vitest/coverage-v8` y un preset nuevo:

  ```js
  // vitest.config.mjs
  import { novaVitestConfig } from '@ahincho/nova-nestjs-toolchain/vitest/index.mjs';
  export default novaVitestConfig();
  ```

  Un servicio que actualice tiene que borrar su `jest.config.js`, escribir ese
  archivo, cambiar `"test"` a `vitest run` y `"test:cov"` a `vitest run --coverage`,
  poner `"types": ["node", "vitest/globals"]` en su `tsconfig.json` y reemplazar
  `jest` por `vitest` en su `publicHoistPattern`. En los specs, `jest.fn` pasa a
  `vi.fn`, `jest.Mock` y `jest.SpyInstance` pasan a `Mock` y `MockInstance`
  importados de `vitest`, y `mockImplementation()` sin argumentos pasa a
  `mockImplementation(() => {})`.

  **Por qué.** `@nestjs/terminus` 12 es sólo ESM, así que Jest necesitaba
  `--experimental-vm-modules` y Node >= 24.9, y esa bandera terminaba escrita en el
  script `test` de cada servicio. NestJS 12 publica su núcleo como ESM, con lo cual
  la bandera pasa de sostener una dependencia a sostener el framework entero.
  Vitest es ESM nativo y no la necesita. En velocidad los dos están parejos sobre
  esta suite; la diferencia medida está en memoria, ~2300 MB de pico contra
  ~1050 MB con cobertura y caché fría, que es lo que corre CI.

  La cobertura la calcula v8 en vez de Istanbul y los números se mueven: en `core`,
  sentencias 98.57 -> 98.15 y ramas 92.51 -> 94.93. El umbral del 80 % no cambia.

## 0.5.0

## 0.4.0

### Minor Changes

- 6f78151: Autenticación por JWT como módulo opcional. `NovaModule.forRoot({ auth: {} })`
  pone un guard global: cada ruta exige `Authorization: Bearer <jwt>` y el
  controlador recibe un `Principal` con `@CurrentUser()`. Lo que no la necesita se
  marca con `@Public()`, y las sondas de salud ya lo traen. Omitir `auth` deja el
  servicio exactamente como estaba.

  El guard **no verifica la firma por defecto**: lee los claims del token tal como
  vino, que es lo correcto detrás de un gateway que ya lo validó. Un servicio
  expuesto directo pone la verificación real en la opción `verify`.

  El identificador sale de `preferred_username` y el rol de `realm_access.roles`,
  las dos configurables junto con la normalización, los roles preferidos y los que
  se descartan. Cuando el módulo de observabilidad está activo, el identificador
  se agrega al contexto y viaja como `x-user-id` hacia cada upstream sin que ningún
  punto de llamada lo pase.

  `RequestContextService` suma `enrich()`, que agrega cabeceras al contexto de la
  petición en vuelo. Existe para lo que se sabe después de abrirlo: el middleware
  corre antes que cualquier guard.

- 30edd67: NestJS deja de ser `peerDependencies` y pasa a ser **dependencia del paquete**. Un
  servicio declara `@ahincho/nova-nestjs` y nada más: `@nestjs/common`, `@nestjs/core`,
  `@nestjs/config`, `@nestjs/platform-express`, `@nestjs/terminus`, `class-validator`,
  `class-transformer`, `reflect-metadata` y `rxjs` llegan con él, en las versiones
  contra las que la plataforma corre su suite.

  Con peers, la elección de versión vivía en cada repositorio: ocho rangos que cada
  equipo podía mover por su cuenta. Ahora la versión está adentro del paquete, así que
  subir NestJS es publicar la plataforma.

  **Requiere una línea en el `pnpm-workspace.yaml` del servicio.** pnpm aísla
  `node_modules`, así que un paquete transitivo no se puede importar; sin esto,
  `import { Module } from '@nestjs/common'` corta con `TS2307`:

  ```yaml
  publicHoistPattern:
    - '@nestjs/*'
    - rxjs
    - reflect-metadata
    - class-validator
    - class-transformer
  ```

  Un servicio que siga declarando las suyas no se rompe: pnpm resuelve una sola copia
  mientras los rangos se crucen. Lo que cambia es que ya no hace falta, y que dejar de
  declararlas es lo que quita la decisión del lado del servicio.

## 0.3.0

### Minor Changes

- 3c51794: Las sondas de salud corren sobre `@nestjs/terminus`, que pasa a ser peer
  dependency. `ready` responde con el cuerpo estándar de terminus
  (`status`, `info`, `error`, `details`) y acepta indicadores nativos por
  `readinessIndicators` junto a los `readinessChecks` de siempre. Entran
  `legacyPath`, para la ruta que un target group ya existente revisa, y
  `gracefulShutdownTimeoutMs`, la ventana en que el servicio responde 503 con
  `status: 'shutting_down'` tras SIGTERM antes de cerrar. `bootstrap()` activa
  los hooks de apagado y deja la ruta heredada fuera de `globalPrefix`.

  Node mínimo pasa a 24.9: terminus 12 es ESM puro y es la versión desde la que
  Jest puede cargarlo con `require(esm)`; en runtime Node lo carga desde 22.12,
  pero la plataforma se prueba y despliega en 24.

## 0.2.1

## 0.2.0

### Minor Changes

- 12c048c: Colapsa los once paquetes en tres. `@ahincho/nova-nestjs` absorbe `api-standard`,
  `nestjs-api-standard`, `nestjs-config`, `nestjs-http`, `nestjs-observability` y
  `nestjs-health`, y reexporta entera la superficie pública de cada uno, así que
  todo lo que antes se importaba de un paquete suelto hoy se importa de este.
  `@ahincho/nova-toolchain` reúne `tsconfig`, `eslint-config` y `jest-preset`
  bajo `tsconfig/`, `eslint/` y `jest/`. Los tres paquetes comparten desde ahora
  un solo número de versión.

## 0.1.1

### Patch Changes

- Updated dependencies
  - @ahincho/nova-nestjs-observability@0.1.1

## 0.1.0

### Minor Changes

- Contexto de request, sondas de salud y el agregador que los une.

  - `nestjs-observability`: contexto sobre `AsyncLocalStorage` que sobrevive a un
    `await`, propagación de las cabeceras de correlación y redacción de las
    cabeceras sensibles en los logs, en petición y en respuesta.
  - `nestjs-health`: `/health/live` y `/health/ready`, exentas del sobre de
    respuesta, con chequeos concurrentes y con fecha límite.
  - `nestjs`: `NovaModule.forRoot()` compone los cinco paquetes y conecta el
    puerto de cabeceras salientes con el contexto de request; `bootstrap()`
    reemplaza el `main.ts` que cada servicio copiaba, y deja las sondas fuera del
    `globalPrefix`.

### Patch Changes

- Updated dependencies
- Updated dependencies [0ada154]
- Updated dependencies [b88d424]
  - @ahincho/nova-nestjs-observability@0.1.0
  - @ahincho/nova-nestjs-health@0.1.0
  - @ahincho/nova-nestjs-config@0.1.0
  - @ahincho/nova-nestjs-http@0.1.0
  - @ahincho/nova-nestjs-api-standard@0.1.0
  - @ahincho/nova-api-standard@0.1.0
