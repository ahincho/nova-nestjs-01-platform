export {
  DEFAULT_REQUEST_ID_HEADER,
  SENSITIVE_HEADERS,
  createRequestLoggerOptions,
  type LogDestination,
  type RequestLoggerOptions,
  type RequestLoggerParams,
} from './logger';
// Se reexportan para que un servicio use la API estructurada de pino sin
// declarar la dependencia: la versión la fija la plataforma, que es el punto.
//
// `Logger` de nestjs-pino NO se reexporta a propósito: colisionaría de nombre
// con el de `@nestjs/common`, y no hace falta. `bootstrap()` lo instala con
// `useLogger`, así que un `new Logger('Servicio')` de toda la vida ya escribe
// por pino.
export { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
export { NovaObservabilityModule } from './nova-observability.module';
export {
  DEFAULT_CORRELATION_HEADERS,
  buildRequestContext,
  type IncomingHeaders,
  type RequestContext,
} from './request-context';
export { RequestContextMiddleware } from './request-context.middleware';
export { RequestContextService } from './request-context.service';
export {
  OBSERVABILITY_OPTIONS,
  resolveObservabilityOptions,
  type NovaObservabilityModuleOptions,
  type RequestIdOptions,
  type ResolvedObservabilityOptions,
  type ResolvedRequestIdOptions,
} from './tokens';
