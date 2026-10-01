---
'@ahincho/nova-nestjs': minor
'@ahincho/nova-nestjs-schematics': minor
'@ahincho/nova-nestjs-toolchain': minor
---

El estándar de API se puede reemplazar sin apagar sus reglas

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
