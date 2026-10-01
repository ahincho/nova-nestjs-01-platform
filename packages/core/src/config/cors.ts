import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export type CorsPolicyOptions = {
  /**
   * Comma-separated list of allowed origins. An empty list allows nothing.
   */
  readonly origins: string;

  /** Extra request headers to allow, on top of the defaults. */
  readonly allowedHeaders?: readonly string[];

  /** Response headers the browser should expose to the calling script. */
  readonly exposedHeaders?: readonly string[];

  /** How long a preflight may be cached, in seconds. Defaults to 86400. */
  readonly maxAgeSeconds?: number;
};

/**
 * Las cabeceras con las que el id de correlación entra y sale por el borde
 * (ADR-037). Es la misma forma que resuelve el módulo de observabilidad.
 */
export type CorsRequestIdHeaders = {
  readonly accept: readonly string[];
  readonly echo: string;
};

const DEFAULT_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'x-request-id',
];

function unique(headers: readonly string[]): string[] {
  const seen = new Set<string>();
  return headers.filter((header) => {
    const key = header.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Builds the CORS policy from the single variable that declares it.
 *
 * The list is the whole policy: no branch on the environment and no implicit
 * loopback. Whoever configures the container decides who may call it, and the
 * answer is readable in the task definition instead of inferred from the code.
 *
 * An empty list allows no origin at all, so a container nobody configured fails
 * closed rather than open.
 *
 * @param requestId - con qué cabeceras entra y sale el id de correlación. Se
 * permiten las de entrada y se expone la de salida sin declararlas aparte: un
 * borde que recibe el id con su propio nombre no sirve si el navegador no puede
 * mandarlo, ni si el script no puede leer el que vuelve.
 */
export function buildCorsOptions(
  options: CorsPolicyOptions,
  requestId?: CorsRequestIdHeaders,
): CorsOptions {
  return {
    origin: options.origins
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),

    // Credentials stay off: auth travels in the Authorization header, never in
    // a cookie. Saying so explicitly is what keeps a later change from pairing
    // credentials with a reflected origin, which is the combination that leaks
    // a session.
    credentials: false,

    allowedHeaders: unique([
      ...DEFAULT_ALLOWED_HEADERS,
      ...(requestId?.accept ?? []),
      ...(options.allowedHeaders ?? []),
    ]),

    // A browser hides a non-simple response header from JavaScript unless the
    // server lists it here, so without this the correlation id set on the
    // response is unreadable by the caller that needs it to report a failure.
    exposedHeaders: requestId
      ? unique([requestId.echo, ...(options.exposedHeaders ?? [])])
      : [...(options.exposedHeaders ?? ['x-request-id'])],

    // Authorization is not a simple header, so every call is preceded by an
    // OPTIONS. Without this the preflight repeats on every single request.
    maxAge: options.maxAgeSeconds ?? 86400,
  };
}
