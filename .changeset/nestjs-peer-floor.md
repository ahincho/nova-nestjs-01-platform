---
'@ahincho/nova-nestjs': patch
---

El piso de NestJS que pide `nestjs-pino`

`nestjs-pino` 5.2.1 pide `@nestjs/common` y `@nestjs/core` `^12.0.2`, y el núcleo
aceptaba `^12.0.1`. Un servicio que instalaba con un lockfile anterior a esa
versión quedaba con 12.0.1 y `pnpm peers check` fallaba, aunque el monorepo
seguía en verde porque su propio lockfile resolvía `nestjs-pino` 5.1.0.

El núcleo pide ahora `^12.0.2` de los dos y `^5.2.1` de `nestjs-pino`, así que el
monorepo prueba la misma combinación que recibe un consumidor. Si el lockfile de
un servicio todavía tiene 12.0.1, basta con:

```bash
pnpm update @nestjs/common @nestjs/core
```
