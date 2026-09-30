# http

Cliente HTTP de salida para servicios NestJS de Nova Platform.

```bash
pnpm add @ahincho/nova-nestjs
```

Construido sobre el `fetch` global de Node, así que **el paquete no trae ninguna
dependencia HTTP**. Lo que agrega sobre un `fetch` pelado es justo lo que cada
servicio venía reescribiendo.

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

**El error del upstream no llega al cliente tal cual.** Un timeout es 504, todo
lo demás es 502. El status propio del upstream describe una topología que el
llamador no debería aprender de un cuerpo de error.

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

El `UpstreamHttpError` que se deja escapar, como el `throw error` de arriba, el
filtro global lo contesta como un error de `infrastructure` (ADR-031): 504 si el
upstream contestó 504 o 408, y 502 si contestó otra cosa. Hasta la 0.15 salía
como 500.

**El log nunca lleva el cuerpo ni el query string.** Un cuerpo de error del
upstream suele devolver los identificadores de la persona sobre la que era la
petición, y un query string los lleva directamente. Del URL se registra sólo
esquema, host y ruta.

## Lo que no hace: reintentar

**No hay reintentos ni corte de circuito, y es deliberado.** Una llamada es una
llamada: si el upstream falla, el fallo se traduce -502 si cayó, 504 si tardó- y
sale con su id de correlación.

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

## Opciones

| Opción             | Por defecto | Para qué                                            |
| ------------------ | ----------- | --------------------------------------------------- |
| `defaultTimeoutMs` | `5000`      | timeout cuando el punto de llamada no dice          |
| `defaultHeaders`   | `{}`        | cabeceras en toda llamada, debajo de las propagadas |

Por llamada: `headers`, `query`, `body`, `timeoutMs`, `forwardError`. La
precedencia de cabeceras es defaults → propagadas → las del punto de llamada.
