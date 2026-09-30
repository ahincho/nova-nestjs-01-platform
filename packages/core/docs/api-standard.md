# api-standard

Sobre de respuesta HTTP de Nova Platform. TypeScript puro, **cero dependencias**:
lo consume NestJS, pero también un Lambda o un script.

```bash
pnpm add @ahincho/nova-nestjs
```

## El contrato

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
cuerpo exitoso cambió. `ApiResponses.withMetadata` es lo que la agrega.

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

El `code` sobrevive a un cambio de transporte. El catálogo es el de ADR-031, el
mismo en los tres stacks:

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

## Nada construye el sobre a mano

`ApiResponses` es el único lugar autorizado a crear el objeto. Un literal suelto
es lo que permite que viaje un `success: true` con `errors` lleno, que ningún
consumidor sabe leer.
