# api-standard

El estándar de API de Nova Platform: la forma de todo lo que un servicio contesta
por HTTP, tanto lo que devuelve como lo que rechaza de su entrada. TypeScript
puro, **cero dependencias**: lo consume NestJS, pero también un Lambda o un
script.

```bash
pnpm add @ahincho/nova-nestjs
```

Son dos cosas, y conviene no confundirlas. **El puerto**, `ApiStandard`, dice qué
tiene que saber hacer un estándar. **El sobre de Nova**, `NovaEnvelopeStandard`,
es la implementación que se registra cuando nadie declara otra. Un servicio que
no hace nada contesta con el sobre, igual que siempre; una organización con su
propio estándar lo trae sin salirse de la plataforma.

## El sobre de Nova

```ts
type ApiResponse<T> = {
  success: boolean;
  status: number;
  data: T | null;
  errors: readonly ApiErrorItem[];
  metadata?: ApiMetadata; // presente en los errores
};

type ApiErrorItem = {
  code: string;
  message: string;
  field: string | null;
};

type ApiMetadata = {
  traceId: string | null;
};
```

`data` y `errors` son excluyentes por construcción: un éxito lleva `errors` vacío,
un fallo lleva `data: null`.

**`metadata.traceId` va en las respuestas de error** (ADR-031): es el id que un
alumno puede citar al reportar la falla, el mismo de la línea de log. Un éxito no
lo trae en el cuerpo -ya viaja en la cabecera `x-request-id`-, así que ningún
cuerpo exitoso cambió. El filtro global siempre lo pone, y la clave nunca falta:
`null` sólo lo escribe un serializador que no tenga el id.
`ApiResponses.withMetadata` es lo que la agrega.

## Uso

```ts
import { ApiResponses, errorItem } from '@ahincho/nova-nestjs';

ApiResponses.ok({ id: 7 }); // 200
ApiResponses.created({ id: 7 }); // 201
ApiResponses.errorOf(404, 'Alumno no encontrado'); // code: NOT_FOUND
ApiResponses.error(400, ...validationErrors);
```

`errorOf` deriva el `code` del status HTTP, y `options.code` lo sobrescribe cuando
el dominio tiene un código propio (`ALREADY_ENROLLED`).

Desde NestJS 12 se puede hacer lo mismo **sin construir el sobre**, poniéndole el
código a la excepción y dejando que el filtro global lo lea:

```ts
throw new NotFoundException('Curso no encontrado', {
  errorCode: 'COURSE_NOT_FOUND',
});
```

Antes, un código de dominio obligaba a escribir una excepción propia por cada uno.
**Solo se lee por debajo de 500**: un 5xx contesta el mensaje genérico a propósito,
y dejar pasar ahí un código de dominio cuenta qué falló por dentro.

## Por qué el cliente ramifica por `code` y no por `status`

El `code` sobrevive a un cambio de transporte. El catálogo de Nova es el de
ADR-031, el mismo en los tres stacks:

| Status | Código               | Status | Código                   |
| ------ | -------------------- | ------ | ------------------------ |
| 400    | `BAD_REQUEST`        | 410    | `GONE`                   |
| 401    | `UNAUTHORIZED`       | 415    | `UNSUPPORTED_MEDIA_TYPE` |
| 403    | `FORBIDDEN`          | 422    | `UNPROCESSABLE_ENTITY`   |
| 404    | `NOT_FOUND`          | 429    | `TOO_MANY_REQUESTS`      |
| 405    | `METHOD_NOT_ALLOWED` | 500    | `INTERNAL_SERVER_ERROR`  |
| 406    | `NOT_ACCEPTABLE`     | 502    | `BAD_GATEWAY`            |
| 408    | `REQUEST_TIMEOUT`    | 503    | `SERVICE_UNAVAILABLE`    |
| 409    | `CONFLICT`           | 504    | `GATEWAY_TIMEOUT`        |

Cualquier otro 4xx lleva `REQUEST_ERROR`, y cualquier otro 5xx,
`INTERNAL_SERVER_ERROR`. **Hasta la 0.15 todo 5xx colapsaba a
`INTERNAL_SERVER_ERROR`**; los tres con nombre propio le dicen al cliente si
conviene reintentar sin nombrar al proveedor, que va sólo al log.

Eso es una convención, no una regla, y la diferencia importa. El status ya viaja
en la línea de estado, así que llamar `BAD_GATEWAY` a un 502 no le cuenta al
cliente nada que no sepa: un catálogo propio lo puede hacer. Lo que ningún
catálogo cambia es el mensaje de un 5xx, que es genérico siempre -eso es
contenido, y lo decide la plataforma antes de que el estándar intervenga-.

## Un estándar propio

```ts
NovaModule.forRoot({
  apiStandard: { standard: OrgStandard }, // una clase, o una instancia
});
```

Un estándar implementa cuatro cosas:

```ts
interface ApiStandard {
  success(payload: unknown, status: number): ApiWire;
  failure(failure: ApiFailure): ApiWire;
  owns(payload: unknown): boolean; // para no envolver dos veces
  readonly openapi: ApiStandardDocs; // cómo se documenta
}
```

`ApiWire` es el cuerpo más, si hace falta, su `Content-Type`: RFC 7807 contesta
sus errores como `application/problem+json`, y el estándar lo puede declarar.

### El estándar decide la forma; la plataforma decide qué se puede decir

Es el reparto que hace seguro reemplazarlo, y está en ADR-034.

| La plataforma decide, siempre                                    | El estándar decide               |
| ---------------------------------------------------------------- | -------------------------------- |
| qué respuestas pasan por el estándar: las HTTP, menos las sondas | la forma del cuerpo de éxito     |
| que un cuerpo ya formateado no se envuelva dos veces             | la forma del error y su tipo     |
| qué status corresponde a cada excepción                          | qué código lleva cada fallo      |
| **que un 5xx no lleve su mensaje ni su código de dominio**       | cómo se describe todo en OpenAPI |
| qué campos fallaron en una validación                            | cómo se escribe ese desglose     |

Por eso `failure()` no recibe la excepción sino un `ApiFailure`: un fallo **ya
clasificado y ya saneado**, con su status, su tipo (`validation`, `request` o
`internal`), el `traceId` y los errores. Un estándar mal escrito no puede filtrar
el cuerpo de un upstream, porque nunca lo tuvo.

### Cambiar solo los códigos

Casi siempre alcanza con eso, y no hace falta escribir un estándar:

```ts
import { NovaEnvelopeStandard } from '@ahincho/nova-nestjs';

NovaModule.forRoot({
  apiStandard: {
    standard: new NovaEnvelopeStandard({
      codes: { byStatus: { 502: 'BAD_GATEWAY', 504: 'GATEWAY_TIMEOUT' } },
    }),
  },
});
```

Los códigos **se suman** al catálogo de Nova en vez de reemplazarlo: quien quiere
nombrar un 502 no tiene que volver a escribir los otros doce. El documento
OpenAPI sale con los mismos nombres, porque los toma del mismo catálogo.

### Reemplazar no es apagar

`wrapResponses: false` y `catchExceptions: false` siguen existiendo, pero están
deprecadas. Apagar el interceptor o el filtro se lleva las reglas con él, y el
servicio las tiene que reescribir: el saneado del 5xx, el caso que no es HTTP,
`@SkipResponseWrapper()`. Reemplazar el estándar deja las reglas donde están.

## Un cuerpo armado a mano

`ApiResponses` es el único lugar autorizado a crear el sobre. Un literal suelto es
lo que permite que viaje un `success: true` con `errors` lleno, que ningún
consumidor sabe leer.

Y un handler que devuelve `ApiResponses.ok(...)` ata el servicio al sobre de
Nova: con otro estándar activo, ese objeto no es un cuerpo del estándar y sale
envuelto como cualquier otro. El status se declara con `@HttpCode()`, que el
interceptor ya lee, sin armar el cuerpo.
