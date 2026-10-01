# http

Cliente HTTP de salida para servicios NestJS de Nova Platform.

```bash
pnpm add @ahincho/nova-nestjs
```

Construido sobre el `fetch` de undici. Lo que agrega sobre un `fetch` pelado es
justo lo que cada servicio venía reescribiendo, y una cosa que ninguno hacía:
decir **qué falló y de quién es el problema** cuando una llamada no sale.

## Uso

```ts
@Module({ imports: [NovaHttpModule.forRoot({ defaultTimeoutMs: 3000 })] })
export class AppModule {}
```

```ts
constructor(private readonly http: HttpClientService) {}

const courses = await this.http.get<CourseResponse[]>(
  `${this.config.url}/v1/courses`,
  { query: { periodId, active: true }, timeoutMs: this.config.timeoutMs },
);
```

`get`, `post`, `put`, `patch`, `delete` y `request`. Las entradas de `query` con
`undefined` o `null` se descartan, así que no hay que armar la cadena a mano.

## Las cuatro cosas que agrega

**El timeout siempre está puesto.** Usa `AbortSignal.timeout`, que corta aunque
el upstream mantenga el socket abierto sin enviar nada — un caso que un deadline
por cabecera no cubre.

**Las cabeceras de correlación viajan solas.** Ningún punto de llamada pasa el
`x-request-id`:

```ts
{ provide: OUTBOUND_HEADERS_PROVIDER, useClass: RequestContextHeaders }
```

Es un puerto inyectado y no una dependencia directa, para que este paquete no
sepa cómo se guarda el contexto. `@ahincho/nova-nestjs` provee uno
sobre `AsyncLocalStorage`. **Si el proveedor falla, la llamada sigue**: perder el
id degrada una traza; hacer fallar la llamada sería una caída.

**El error del upstream no llega al cliente tal cual.** Sale como 502, 503 o 504
según qué falló -la tabla está más abajo- y con el mensaje genérico. El status
propio del upstream describe una topología que el llamador no debería aprender
de un cuerpo de error.

Cuando el caller sí necesita mapear la semántica del upstream — un 404 que debe
seguir siendo 404 — lo pide explícito:

```ts
try {
  await this.http.get(url, { forwardError: true });
} catch (error) {
  if (error instanceof UpstreamHttpError && error.statusCode === 404) {
    throw new NotFoundException('Alumno no encontrado');
  }
  throw error;
}
```

Lo que se relanza sin traducir -el `throw error` del final- sale igual que sin
`forwardError`: el filtro global lo contesta como un error de `infrastructure`
(ADR-031), 504 si el upstream contestó 504 o 408, y 502 si contestó otra cosa.
Hasta la 0.15 salía como 500. `UpstreamHttpError` es una `UpstreamException`,
así que el patrón de traducir lo que se entiende y relanzar el resto no convierte
un fallo del upstream en uno propio.

**El log nunca lleva el cuerpo ni el query string.** Un cuerpo de error del
upstream suele devolver los identificadores de la persona sobre la que era la
petición, y un query string los lleva directamente. Del URL se registra sólo
esquema, host y ruta.

## Qué falló, y de quién es el problema

Todo fallo sale como `UpstreamException`, clasificado con el registro de
**RFC 9209**, el estándar que define los errores de un intermediario que no pudo
obtener respuesta del siguiente salto. Un BFF y un ACL son exactamente eso. La
decisión está en ADR-035.

La categoría es lo que contesta «¿a quién le toca?»:

| Categoría      | Qué pasó                                       | Tipos                                                                                                                                              | Status                        |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `connectivity` | no se llegó a hablar con el upstream           | `dns_error`, `dns_timeout`, `destination_ip_unroutable`, `connection_refused`, `connection_timeout`, `tls_certificate_error`, `tls_protocol_error` | 502; 504 los timeouts         |
| `timeout`      | se llegó, y no contestó a tiempo               | `http_response_timeout`, `connection_read_timeout`                                                                                                 | 504                           |
| `network`      | la conexión se cortó o la respuesta llegó rota | `connection_terminated`, `http_response_incomplete`, `http_protocol_error`                                                                         | 502                           |
| `response`     | contestó con un status de error                | ninguno: se registra el `receivedStatus`                                                                                                           | 502; 504 si recibió 504 o 408 |
| `contract`     | contestó 2xx con un cuerpo que no es JSON      | `http_response_content_invalid`                                                                                                                    | 502                           |
| `internal`     | el fallo es nuestro, antes de salir            | `proxy_internal_error`, `proxy_configuration_error`                                                                                                | 500                           |

**Un timeout al conectar es conectividad, no lentitud.** Que la conexión no se
establezca casi nunca es un upstream lento: en una red con grupos de seguridad es
un paquete que alguien descarta, y se arregla con configuración de red. Es el
error de triage más caro de esta familia, y la tabla lo separa a propósito.

La clasificación sale de provocar cada fallo contra un servidor real y mirar qué
lanza undici, no de la documentación. Una prueba de integración lo repite en cada
build, porque es lo primero que se rompería si una versión mayor de undici
cambiara sus códigos.

### Dónde se ve

En una sola línea de log, la del filtro de errores, con la clasificación y la
llamada como campos y no dentro del mensaje:

```jsonc
{
  "level": 50,
  "context": "AllExceptionsFilter",
  "msg": "Upstream service error",
  "upstream": {
    "upstream": "academic.internal:8080",
    "category": "connectivity",
    "type": "connection_refused",
    "code": "ECONNREFUSED",
    "phase": "connect",
    "elapsedMs": 3,
    "status": 502,
  },
  "outbound": {
    "method": "GET",
    "url": "http://academic.internal:8080/v1/courses",
    "timeoutMs": 3000,
  },
  "statusCode": 502,
  "traceId": "5077a1db-d22b-4d8f-96f1-4648cbb04901",
  "err": {
    "type": "UpstreamException",
    "message": "Upstream service error: fetch failed: connect ECONNREFUSED 10.0.3.14:8080",
    "stack": "UpstreamException: Upstream service error\n    at ...",
  },
}
```

Un tablero cuenta fallos por `upstream.category` sin parsear texto, y una alerta
sobre `connectivity` no se dispara por un 404 de negocio. `upstream` nombra al
upstream sólo por su host, porque es lo que se agrupa; la ruta, que puede llevar
identificadores de la persona, va aparte en `outbound`, para leer esa línea y no
para contar.

**El cliente no registra el fallo: lo registra quien decide qué hacer con él.**
Si nadie lo atrapa, es el filtro, con esa línea. Registrarlo también en el
cliente dejaba dos líneas de error por cada fallo, y una falsa cuando el
llamador ya lo había resuelto, como el 404 que se traduce a propósito.

El costo es que un fallo que el llamador atrapa para degradar la respuesta no
deja rastro si el llamador no lo registra. Ese log es suyo, y la excepción trae
los campos listos:

```ts
try {
  return await this.http.get<Banner[]>(url);
} catch (error) {
  if (error instanceof UpstreamException) {
    this.logger.warn(
      error.logFields,
      'Banners unavailable, answering without them',
    );
    return [];
  }
  throw error;
}
```

**En el cuerpo, nada.** El 5xx sigue saliendo con el mensaje genérico: el tipo y
el nombre del upstream describen la topología, y el RFC mismo advierte que
mostrárselos a un cliente le dice a un atacante dónde está cada servicio.

### Tres cosas que cambiaron

- **Un corte a mitad del cuerpo es un 502.** Antes se leía fuera de la
  traducción de errores y salía como un 500 sin clasificar: el tablero contaba un
  defecto propio donde hubo un problema de red.
- **Un 2xx que no es JSON falla.** Antes se devolvía el texto como si fuera el
  `T` prometido, y el error aparecía más adelante, lejos de la causa. Con
  `forwardError`, el cuerpo de un error sigue llegando como texto si no es JSON.
- **Un error de `forwardError` que se relanza es un 502.** Antes era un `Error`
  suelto, y el filtro lo contestaba como un fallo propio: 500, el mismo defecto
  contado del lado equivocado.

## Probar un servicio que llama a otros

El cliente no usa el `fetch` global, así que `global.fetch = vi.fn()` ya no
intercepta nada. Lo que se reemplaza es el transporte:

```ts
import { NOVA_HTTP_TRANSPORT } from '@ahincho/nova-nestjs';

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(NOVA_HTTP_TRANSPORT)
  .useValue(fetchMock)
  .compile();
```

`fetchMock` recibe la URL y un objeto con `method`, `headers`, `body` y `signal`,
y devuelve un `Response`. Es el mismo contrato que tenía el `fetch` global, así
que una suite que lo simulaba sólo cambia dónde lo engancha.

## Lo que no hace: reintentar

**No hay reintentos ni corte de circuito, y es deliberado.** Una llamada es una
llamada: si el upstream falla, el fallo se clasifica y sale con su id de
correlación.

Tres razones. Un reintento automático **amplifica** el incidente que pretende
cubrir: el caso donde aparece de verdad no es el fallo aislado sino el upstream
saturado, y ahí duplicar el tráfico entrante es la diferencia entre lento y
caído. No se puede reintentar sin saber si la operación es **idempotente**, y un
cliente genérico que sólo ve el método está adivinando el contrato del upstream.
Y el lugar donde esto se resuelve bien es la infraestructura, que ve toda la
flota, no un proceso que sólo ve sus propias llamadas.

Un servicio que necesite reintentar una llamada concreta lo hace **en su caso de
uso**, que es donde sí sabe si esa operación se puede repetir. Lo que no hay es
una política automática y global.

El detalle, con las consecuencias negativas y el disparador que obliga a
revisarlo, está en ADR-029.

## El pool de conexiones

Viene encendido. Todas las llamadas salientes comparten un `Agent` de undici, y
sin él cada petición abre y cierra su propio socket:

```ts
NovaHttpModule.forRoot({ pool: { connections: 100 } });
```

Medido sobre un servidor real, doce llamadas concurrentes al mismo upstream:
**doce sockets sin pool, dos con `connections: 2`**. El pool se cierra al apagar
esperando a las llamadas en vuelo, con un tope, para que un upstream atascado no
deje el cierre colgado hasta que llegue el SIGKILL.

**Uno solo y no uno por upstream.** Un pool por upstream multiplica la
configuración y las métricas, y lo que se quiere mirar -cuántas conexiones tiene
vivas este contenedor- deja de ser un número. El upstream que de verdad necesita
el suyo -otro TLS, un certificado fijado- lo pasa por llamada como `dispatcher`.

El cliente usa el `fetch` **de undici**, no el global. No es una preferencia: el
`fetch` de Node trae su propia copia de undici embebida -la 7.28 en Node 24.18- y
rechaza un despachador del paquete, que es la 8.10, con `InvalidArgumentError:
invalid onRequestStart method`.

## Opciones

| Opción             | Por defecto | Para qué                                            |
| ------------------ | ----------- | --------------------------------------------------- |
| `defaultTimeoutMs` | `5000`      | timeout cuando el punto de llamada no dice          |
| `defaultHeaders`   | `{}`        | cabeceras en toda llamada, debajo de las propagadas |
| `pool`             | encendido   | `false` lo apaga y cada llamada abre su socket      |

Del pool: `connections` (50), `pipelining` (10), `keepAliveTimeoutMs` (30000),
`closeTimeoutMs` (5000).

Por llamada: `headers`, `query`, `body`, `timeoutMs`, `forwardError`,
`dispatcher`. La precedencia de cabeceras es defaults → propagadas → las del
punto de llamada.
