# api

Integración con NestJS del estándar de API de Nova Platform. Registra un
interceptor y un filtro globales para que ningún controlador arme el cuerpo a
mano, y los dos le dan forma a la respuesta con el estándar activo: el sobre de
Nova, salvo que el servicio declare otro.

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

`NovaModule.forRoot()` lo monta solo; su opción `apiStandard` es la misma que
recibe este `forRoot()`.

## Otro estándar

```ts
NovaModule.forRoot({
  apiStandard: { standard: OrgStandard },
});
```

`standard` acepta una clase -que se resuelve por inyección, así que puede recibir
dependencias- o una instancia, como un `NovaEnvelopeStandard` con códigos
propios. Qué tiene que implementar y qué no puede cambiar está en
[api-standard](api-standard.md#un-estándar-propio).

Lo que conviene tener claro de este lado es que **el interceptor y el filtro no se
van**. Siguen decidiendo qué pasa por el estándar y qué se le puede decir al
cliente; el estándar sólo decide la forma. Un servicio que reemplaza el estándar
conserva el saneado del 5xx sin haberlo escrito.

## La entrada

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

`bootstrap()` ya lo instala así, y además rechaza la propiedad que ningún DTO
declara. Un servicio que arma su aplicación a mano lo copia.

Cada restricción incumplida llega como una violación con su campo, y un DTO
anidado se aplana con ruta punteada (`address.zipCode`) para que el formulario
pueda resaltar el input exacto.

La violación es **neutra**: dice qué campo y por qué, y nada más. El nombre del
fallo -`VALIDATION_ERROR` en el sobre de Nova- lo pone el catálogo del estándar
activo, así que otro estándar puede contar la misma entrada rechazada con sus
propias palabras. Qué se valida, en cambio, no cambia con el estándar.

`ValidationException.violations` es donde se leen. `validationErrors` sigue
existiendo, deprecada, y devuelve lo mismo que antes: las entradas con la forma
del sobre de Nova.

## Dejar una ruta fuera del estándar

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

Vale con cualquier estándar: la forma de una sonda no es de la organización.

## Opciones

| Opción                 | Por defecto               | Para qué                                    |
| ---------------------- | ------------------------- | ------------------------------------------- |
| `standard`             | el sobre de Nova          | la forma de las respuestas y de los errores |
| `errors`               | los puertos de Nova       | catálogo, status y cuerpo de los errores    |
| `internalErrorMessage` | `'Internal server error'` | mensaje de todo 5xx                         |
| `wrapResponses`        | `true`                    | **deprecada**: reemplazar con `standard`    |
| `catchExceptions`      | `true`                    | **deprecada**: reemplazar con `standard`    |

Las dos deprecadas apagan el interceptor o el filtro, y apagarlos se lleva con
ellos las reglas. Siguen funcionando para no romper a quien las usa.

Dentro de `NovaModule`, los puertos de los errores se declaran en su propia
opción: `NovaModule.forRoot({ errors: { catalog, statusMapper, serializer } })`.
Qué decide cada uno está en [errors.md](errors.md).

## Tres decisiones que conviene conocer

**Ningún 5xx llega con su mensaje real.** `connect ECONNREFUSED 10.0.3.14:5432`
va al log; el cliente recibe el mensaje genérico, con cualquier estándar, y con el
de Nova el código de su status: `BAD_GATEWAY`, `SERVICE_UNAVAILABLE`,
`GATEWAY_TIMEOUT` o `INTERNAL_SERVER_ERROR`. Alcanza para decidir si reintentar
sin nombrar al proveedor.

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

**El stack va en `err`, nunca en el mensaje.** La línea de un 5xx lleva el
mensaje de la excepción -«Upstream service timed out»- y el error en `err`, con
su tipo, su mensaje y su stack. Pegado al mensaje, el stack hacía única cada
línea, y agrupar por mensaje en el índice dejaba de servir justo para los
errores. Un 4xx lleva su mensaje y ningún stack: apuntaría al código que
rechazó la petición, que funcionó bien.

El filtro escribe con el `Logger` de Nest, así que si la aplicación instaló pino
con `app.useLogger()`, estas entradas salen en ese formato. El paquete no depende
de ninguna librería de logging. Los argumentos van con la forma de pino -los
campos primero, el mensaje después-, que es como los lee el logger de la
plataforma.

La línea de log **no cambia con el estándar**: sus códigos salen siempre del
catálogo de Nova. Es de observabilidad, y cambiar la forma de la respuesta no
puede cambiar lo que buscan las consultas del índice.
