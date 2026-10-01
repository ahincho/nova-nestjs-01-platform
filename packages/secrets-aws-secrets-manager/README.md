# @ahincho/nova-nestjs-secrets-aws-secrets-manager

AWS Secrets Manager como almacén de secretos de Nova Platform para NestJS. Un
servicio lo instala y pide sus secretos; nunca importa nada de este paquete.

```bash
pnpm add @ahincho/nova-nestjs-secrets-aws-secrets-manager
```

```ts
void bootstrap(AppModule, {
  secrets: { imports: ['aws-secrets-manager:prod/plaza-bff/db'] },
});
```

O desde la task definition:
`NOVA_SECRETS_IMPORT=aws-secrets-manager:prod/plaza-bff/db`. La referencia es el
nombre o el ARN del secreto, escrito tal cual.

| Variable                                    | Por defecto                      |
| ------------------------------------------- | -------------------------------- |
| `NOVA_SECRETS_AWS_SECRETS_MANAGER_REGION`   | `AWS_REGION` y la cadena del SDK |
| `NOVA_SECRETS_AWS_SECRETS_MANAGER_ENDPOINT` | solo para un emulador            |
| `NOVA_SECRETS_AWS_SECRETS_MANAGER_TIMEOUT`  | `5s`                             |

Las credenciales salen de la cadena del SDK: dentro de ECS, del rol de la tarea.

**Un secreto de AWS es un JSON**, y este paquete lo abre con las mismas reglas
que el desdoblado del entorno de `@ahincho/nova-nestjs`: un servicio que hoy
recibe el secreto inyectado por ECS en una variable puede pasar a pedirlo acá y
obtiene exactamente las mismas variables. Un secreto guardado como binario corta
el arranque. Hace un solo intento por llamada, sin reintentos, como el cliente
HTTP de la plataforma.

El detalle está en [la documentación de configuración](../core/docs/config.md#los-secretos-de-un-almacén)
y en [ADR-049](https://github.com/ahincho/nova-shared-01-docs/blob/main/adrs/shared/ADR-049-secretos-en-quarkus-y-nestjs.md).

## Licencia

[Eclipse Public License 2.0](../../LICENSE).
