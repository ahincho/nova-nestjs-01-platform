---
'@ahincho/nova-nestjs': minor
'@ahincho/nova-nestjs-schematics': minor
'@ahincho/nova-nestjs-toolchain': minor
'@ahincho/nova-nestjs-secrets-vault': minor
'@ahincho/nova-nestjs-secrets-aws-secrets-manager': minor
---

Los secretos de un almacén: Vault y AWS Secrets Manager

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
