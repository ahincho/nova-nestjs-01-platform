import type { ApiErrorItem } from './api-error';
import type { ApiMetadata, ApiResponse } from './api-response';
import { statusToErrorCode } from './error-code';

/**
 * Options accepted by {@link ApiResponses.errorOf}.
 */
export type ErrorOptions = {
  /** Overrides the code derived from the HTTP status. */
  readonly code?: string;
  /** Names the offending input. Defaults to `null`. */
  readonly field?: string | null;
};

/**
 * The single source of truth for building {@link ApiResponse} envelopes.
 *
 * Every endpoint, interceptor and exception filter goes through here. Building
 * the object literally elsewhere is what lets a `success: true` ship next to a
 * populated `errors`, which no consumer knows how to read.
 */
export const ApiResponses = {
  /**
   * A successful response carrying `data`.
   *
   * @param status - HTTP status to report. Defaults to `200`.
   */
  ok<T>(data: T, status = 200): ApiResponse<T> {
    return { success: true, status, data, errors: [] };
  },

  /**
   * A successful `201` response carrying the created resource.
   */
  created<T>(data: T): ApiResponse<T> {
    return ApiResponses.ok(data, 201);
  },

  /**
   * A failed response carrying one or more error entries.
   *
   * @example
   * ApiResponses.error(404, errorItem('NOT_FOUND', 'Student not found'));
   * ApiResponses.error(400, ...validationErrors);
   */
  error(status: number, ...errors: ApiErrorItem[]): ApiResponse<never> {
    return { success: false, status, data: null, errors };
  },

  /**
   * A failed response built from a message, deriving the error code from the
   * HTTP status unless `options.code` overrides it.
   */
  errorOf(
    status: number,
    message: string,
    options: ErrorOptions = {},
  ): ApiResponse<never> {
    return ApiResponses.error(status, {
      code: options.code ?? statusToErrorCode(status),
      message,
      field: options.field ?? null,
    });
  },

  /**
   * El mismo sobre, con su `metadata`.
   *
   * Es lo que usa el serializador de errores de Nova para poner el `traceId` en
   * el cuerpo. Devuelve un objeto nuevo en vez de escribir sobre el recibido.
   *
   * @example
   * const failure = ApiResponses.errorOf(404, 'Curso no encontrado');
   * ApiResponses.withMetadata(failure, { traceId: 'b3f1c2d4' });
   */
  withMetadata<T>(
    response: ApiResponse<T>,
    metadata: ApiMetadata,
  ): ApiResponse<T> {
    return { ...response, metadata };
  },

  /**
   * Whether `value` already is an envelope.
   *
   * The response interceptor calls this to leave an endpoint that built its own
   * envelope untouched, instead of wrapping it a second time.
   */
  isApiResponse(value: unknown): value is ApiResponse<unknown> {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate['success'] === 'boolean' &&
      typeof candidate['status'] === 'number' &&
      'data' in candidate &&
      Array.isArray(candidate['errors'])
    );
  },
} as const;
