// La superficie de `@ahincho/nova-nestjs/errors`. Nada de lo que se exporta
// acá importa Nest ni ningún otro framework web (ADR-031): lo verifican una
// regla de oxlint y `framework-free.spec.ts`, que sigue también los imports que
// salen de esta carpeta.
//
// Los tipos del fallo saneado que reciben los puertos, para que quien escribe
// uno los nombre sin traer el paquete principal.
export type {
  ApiFailure,
  ApiFailureItem,
  ApiFailureKind,
  ApiWire,
} from '../api-standard/api-standard';
export {
  ApplicationError,
  type ApplicationErrorInit,
  type ApplicationErrorOptions,
  type RetryableErrorOptions,
} from './application-error';
export { DomainError, type DomainErrorOptions } from './domain-error';
export {
  ApplicationErrorType,
  DomainErrorType,
  InfrastructureErrorType,
  PlatformErrorType,
  type ErrorType,
} from './error-type';
export {
  InfrastructureError,
  type InfrastructureErrorOptions,
  type RetryableInfrastructureErrorOptions,
} from './infrastructure-error';
export { Layer } from './layer';
export {
  DEFAULT_INTERNAL_ERROR_MESSAGE,
  NovaErrorCatalog,
  type NovaErrorCatalogOptions,
} from './nova-error-catalog';
export { NovaErrorSerializer } from './nova-error-serializer';
export { NovaErrorStatusMapper } from './nova-error-status-mapper';
export {
  NovaError,
  type FieldError,
  type LayeredError,
  type NovaErrorInit,
} from './nova-error';
export { PlatformError, type PlatformErrorOptions } from './platform-error';
export type {
  ErrorCatalog,
  ErrorClassification,
  ErrorDescription,
  ErrorPorts,
  ErrorSerializer,
  ErrorStatusMapper,
  SanitizedError,
} from './ports';
