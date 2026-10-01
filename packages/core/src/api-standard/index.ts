export type { ApiErrorItem } from './api-error';
export { errorItem } from './api-error';
export type { ApiMetadata, ApiResponse } from './api-response';
export type { ErrorOptions } from './api-responses';
export { ApiResponses } from './api-responses';
export type {
  ApiFailure,
  ApiFailureItem,
  ApiFailureKind,
  ApiStandard,
  ApiStandardDocResponse,
  ApiStandardDocs,
  ApiWire,
  OpenApiSchema,
} from './api-standard';
export {
  DEFAULT_ERROR_CODE,
  INTERNAL_ERROR_CODE,
  NOVA_ERROR_CATALOG,
  errorCodeFor,
  mergeErrorCatalog,
  statusToErrorCode,
  type ApiErrorCatalog,
} from './error-code';
// `DEFAULT_INTERNAL_ERROR_MESSAGE` se exporta desde `errors`, que es donde lo
// usa el catálogo; exportarlo también acá lo dejaría duplicado en el paquete.
export {
  DEFAULT_REQUEST_ERROR_MESSAGE,
  statusToErrorMessage,
} from './error-message';
export {
  ENVELOPE_SCHEMA_NAME,
  ERROR_ITEM_SCHEMA_NAME,
  METADATA_SCHEMA_NAME,
  NovaEnvelopeStandard,
  type NovaEnvelopeOptions,
} from './nova-envelope.standard';
