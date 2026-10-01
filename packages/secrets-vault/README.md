# @ahincho/nova-nestjs-secrets-vault

HashiCorp Vault, motor KV versión 2, como almacén de secretos de Nova Platform
para NestJS. Un servicio lo instala y pide sus secretos; nunca importa nada de
este paquete.

```bash
pnpm add @ahincho/nova-nestjs-secrets-vault
```

```ts
void bootstrap(AppModule, { secrets: { imports: ['vault:plaza-bff'] } });
```

O desde la task definition: `NOVA_SECRETS_IMPORT=vault:plaza-bff`. Las claves del
secreto quedan como variables de entorno antes de que exista la aplicación, así
que un `registerAs` ya las encuentra.

| Variable                                             | Por defecto                  |
| ---------------------------------------------------- | ---------------------------- |
| `NOVA_SECRETS_VAULT_ADDRESS`                         | `VAULT_ADDR`                 |
| `NOVA_SECRETS_VAULT_TOKEN`                           | `VAULT_TOKEN`                |
| `NOVA_SECRETS_VAULT_APP_ROLE_ROLE_ID` y `_SECRET_ID` | AppRole; gana sobre el token |
| `NOVA_SECRETS_VAULT_APP_ROLE_MOUNT`                  | `approle`                    |
| `NOVA_SECRETS_VAULT_MOUNT`                           | `secret`                     |
| `NOVA_SECRETS_VAULT_TIMEOUT`                         | `5s`                         |

Son las mismas claves y las mismas reglas que el adaptador de Java
(`nova-secrets-vault`): un secreto que Vault no tiene es un secreto ausente, un
403 dice que el token o el AppRole no puede leerlo, y ningún error cita la
respuesta de Vault. Habla con la API HTTP de Vault con el `fetch` de Node, sin un
cliente de terceros.

El detalle está en [la documentación de configuración](../core/docs/config.md#los-secretos-de-un-almacén)
y en [ADR-049](https://github.com/ahincho/nova-shared-01-docs/blob/main/adrs/shared/ADR-049-secretos-en-quarkus-y-nestjs.md).

## Licencia

[Eclipse Public License 2.0](../../LICENSE).
