# openapi

El documento OpenAPI y su interfaz, para servicios NestJS de Nova Platform.

```bash
pnpm add @ahincho/nova-nestjs
```

## Publicarlo

```ts
void bootstrap(AppModule, {
  globalPrefix: 'api/v1',
  openapi: {
    title: 'Academic ACL',
    description: 'Traduce el modelo del sistema académico legado',
  },
});
```

La interfaz queda en `/docs` y el documento JSON en `/docs/json`.

**Omitir la opción no publica nada**, igual que con CORS y con `auth`. Exponer
la documentación de un servicio interno es una decisión de quien lo despliega, y
la plataforma no la toma por él.

Cuando sí se publica pero hay que poder apagarla por ambiente, está `enabled`,
que deja el título y los tags escritos donde se leen:

```ts
openapi: {
  title: 'Academic ACL',
  enabled: process.env['OPENAPI_ENABLED'] !== 'false',
}
```

### Fuera del prefijo global

La documentación **no** hereda el `globalPrefix`. El prefijo versiona la API, y
la documentación no es parte de lo versionado: si lo heredara, pasar de `v1` a
`v2` movería el enlace que todo el mundo tiene guardado. Con
`useGlobalPrefix: true` se hereda, para quien prefiera lo contrario.

Las sondas de salud sí aparecen en el documento. Son rutas que el servicio
atiende, y esconderlas haría que el documento mienta por omisión.

## El sobre

Acá está la parte que un `@nestjs/swagger` suelto no puede resolver. **El
interceptor envuelve la respuesta después de que el controlador la devolvió**,
así que un documento generado a partir del tipo de retorno describe lo que sale
del método y no lo que sale por el cable:

```jsonc
// lo que devuelve el controlador       // lo que recibe el cliente
{ "id": "1", "name": "Cálculo I" }      { "success": true, "status": 200,
                                          "data": { "id": "1", ... },
                                          "errors": [] }
```

Un cliente generado del primer documento no compila contra el servicio real.
`ApiEnvelope` cierra esa distancia:

```ts
@Get(':id')
@ApiEnvelope(CourseResponse, { description: 'El curso pedido' })
@ApiErrors(404)
findOne(@Param('id') id: string): Promise<CourseResponse> {
  return this.courses.findOne(id);
}

@Get()
@ApiEnvelope(CourseResponse, { isArray: true })
findAll(): Promise<CourseResponse[]> {
  return this.courses.findAll();
}
```

`ApiErrors` documenta los fallos con el mismo sobre, y **el código de cada uno
sale de `statusToErrorCode`**, que es la misma función que usa el catálogo de
Nova en tiempo de ejecución. Escribirlo a mano dejaría que el documento y el
servicio se contradijeran sin que nada avise. Un servicio que reemplaza el
catálogo contesta sus propios códigos, y en ese caso es el servicio quien tiene
que declararlos en el documento.

Cada fallo documentado declara además `metadata.traceId` como requerido (ADR-031):
es el id que se cita al reportar la falla. En el sobre base es opcional, porque un
éxito no lo trae.

## El token

`bearerAuth` está en `true` por defecto y el requisito se declara **en la raíz
del documento**, no operación por operación. Es lo que corresponde cuando
`NovaModule` recibe `auth`: ese guard es global, así que lo excepcional es la
ruta pública, no la protegida. Documentarlo con un decorador en cada método
invertiría el default y dejaría como abierto todo lo que alguien olvidó anotar.

Un servicio sin `auth` lo pone en `false` -es lo que hace el generador-, y
entonces el documento no declara ningún esquema de seguridad.

## Opciones

| Opción            | Por defecto | Qué hace                                         |
| ----------------- | ----------- | ------------------------------------------------ |
| `title`           | requerido   | encabeza el documento                            |
| `description`     | vacío       | qué hace el servicio                             |
| `version`         | `1.0.0`     | versión de la API, no la del paquete             |
| `path`            | `docs`      | la interfaz; el JSON queda en `<path>/json`      |
| `enabled`         | `true`      | permite apagarla sin sacar el bloque             |
| `bearerAuth`      | `true`      | declara el esquema y lo exige en todas las rutas |
| `useGlobalPrefix` | `false`     | sirve la documentación bajo el prefijo de la API |
| `servers`         | vacío       | dónde responde esta API                          |
| `tags`            | vacío       | agrupa las operaciones                           |

## Armar la aplicación a mano

Un servicio que no usa `bootstrap()` monta la documentación por su cuenta con la
misma función:

```ts
import { setupOpenApi } from '@ahincho/nova-nestjs';

setupOpenApi(app, { title: 'Academic ACL' });
```

Va **después** de `setGlobalPrefix` -si no, `useGlobalPrefix` no tiene qué
heredar- y **antes** de `listen`, para que el documento exista desde la primera
petición.

## El costo

`@nestjs/swagger` arrastra `swagger-ui-dist`, que son unos megabytes de assets
dentro de la imagen. Se paga siempre, aunque `enabled` esté en `false`: la
dependencia se instala igual. Es deliberado -que los decoradores existan sin
instalar nada aparte es la mitad del valor- y está anotado en el ADR-023.

Con él entra `@scarf/scarf`, cuyo script de instalación es telemetría. Va
apagado en el `pnpm-workspace.yaml` que genera el schematic:

```yaml
allowBuilds:
  '@scarf/scarf': false
```

Sin esa decisión escrita, `pnpm install` aborta antes de compilar nada.
