# api

Integración con NestJS del sobre de respuesta de Nova Platform. Registra un
interceptor y un filtro globales para que ningún controlador arme el sobre a mano.

```bash
pnpm add @ahincho/nova-nestjs
```

## Activación

En NestJS **nada se activa solo**: no hay escaneo de classpath como en Spring Boot,
así que la activación es una llamada explícita.

```ts
import { ApiStandardModule } from '@ahincho/nova-nestjs';

@Module({
  imports: [ApiStandardModule.forRoot()],
})
export class AppModule {}
```

Con eso, un controlador devuelve su objeto de dominio:

```ts
@Get(':id')
findOne(@Param('id') id: string) {
  return this.service.findOne(id);   // -> { success: true, status: 200, data: {...}, errors: [] }
}
```

## Errores de validación

```ts
import { validationExceptionFactory } from '@ahincho/nova-nestjs';

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    exceptionFactory: validationExceptionFactory,
  }),
);
```

Cada restricción incumplida viaja como una entrada con su campo, y un DTO anidado
se aplana con ruta punteada (`address.zipCode`) para que el formulario pueda
resaltar el input exacto.

## Dejar una ruta fuera del sobre

```ts
@SkipResponseWrapper()
@Get('live')
live() {
  return { status: 'ok' };
}
```

Las sondas de salud son el motivo de que exista: el balanceador revisa la **forma**
del cuerpo, y envolverlo lo convierte en `{ data: { status: 'ok' } }`. El status
sigue siendo 200, así que el target group sigue pasando y nada delata el cambio.

## Opciones

| Opción                 | Por defecto               | Para qué                                    |
| ---------------------- | ------------------------- | ------------------------------------------- |
| `wrapResponses`        | `true`                    | registra el interceptor global              |
| `catchExceptions`      | `true`                    | registra el filtro global                   |
| `internalErrorMessage` | `'Internal server error'` | mensaje de todo 5xx con el catálogo de Nova |
| `errors`               | los puertos de Nova       | catálogo, status y cuerpo de los errores    |

Dentro de `NovaModule`, los puertos se declaran en su propia opción:
`NovaModule.forRoot({ errors: { catalog, statusMapper, serializer } })`. Qué
decide cada uno está en [errors.md](errors.md).

## Tres decisiones que conviene conocer

**Ningún 5xx llega con su mensaje real.** `connect ECONNREFUSED 10.0.3.14:5432`
va al log; el cliente recibe el mensaje genérico y el código de su status, que es
`BAD_GATEWAY`, `SERVICE_UNAVAILABLE`, `GATEWAY_TIMEOUT` o `INTERNAL_SERVER_ERROR`.
Alcanza para decidir si reintentar sin nombrar al proveedor.

**Lo esperado se registra como `warn`, no como `error`.** Un 4xx es el cliente
equivocándose o una regla de negocio que dijo que no, no una falla nuestra;
registrarlo como error entierra los incidentes que sí importan. Lo que decide el
nivel es la capa (ADR-031) y no el status: `domain` y `application` van en
`warn`, sin stack, e `infrastructure` y `platform` van en `error`, con su causa
encadenada. Con los puertos de Nova es lo mismo que mirar si el status es 5xx, y
un `ErrorStatusMapper` propio no mueve la señal.

**Cada línea lleva la capa como campo** (ADR-031): `traceId`, `layer`, `type`,
`code` y, si hay, `upstream`, además de `status`, `method` y `path`. El
`traceId` es el mismo que el cliente ve en `metadata.traceId`. Una excepción del
framework se lee por su status: un 4xx es `application`, un 502, 503 o 504 es
`infrastructure`, y lo demás, `platform`.

El filtro escribe con el `Logger` de Nest, así que si la aplicación instaló pino
con `app.useLogger()`, estas entradas salen en ese formato. El paquete no depende
de ninguna librería de logging.
