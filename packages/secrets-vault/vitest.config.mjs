import { novaVitestConfig } from '@ahincho/nova-nestjs-toolchain/vitest/index.mjs';

// Un almacén no es un módulo de Nest: no declara decoradores, así que no carga reflect-metadata.
export default novaVitestConfig({ setupFiles: [] });
