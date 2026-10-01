import {
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContextService } from '../observability';
import { bearerToken, decodeJwtClaims, type JwtClaims } from './jwt';
import { resolvePrincipal, type Principal } from './principal';
import { IS_PUBLIC } from './public.decorator';
import { AUTH_OPTIONS, type ResolvedAuthOptions } from './tokens';

/**
 * La petición una vez que el guard la dejó pasar.
 *
 * Estructural y no el `Request` de Express: el paquete no depende de un
 * servidor HTTP concreto, y así vale igual con Fastify.
 */
export type AuthenticatedRequest = {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  user?: Principal;
};

/**
 * Lee una cabecera sin distinguir mayúsculas.
 *
 * Express ya las normaliza a minúsculas, pero acá la petición está tipada de
 * forma estructural y no hay servidor que lo garantice.
 */
function header(
  headers: AuthenticatedRequest['headers'],
  name: string,
): unknown {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

/**
 * Resuelve quién hace la petición y la rechaza si el token no lo dice.
 *
 * Se registra como guard global cuando la aplicación declara `auth`, así que
 * protege todas las rutas; las que no lo necesitan llevan `@Public()`.
 */
@Injectable()
export class NovaAuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_OPTIONS)
    private readonly options: ResolvedAuthOptions,
    private readonly reflector: Reflector,
    // Opcional porque el guard sirve solo: sin el módulo de observabilidad
    // sigue autenticando, lo único que se pierde es que el id del usuario
    // viaje hacia los upstreams.
    @Optional()
    private readonly context?: RequestContextService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    // La identidad que viaja hacia adentro la escribe sólo la autenticación
    // (ADR-037). Lo que el contexto haya copiado de la petición con estos
    // nombres lo escribió quien llama, y se quita antes de mirar si la ruta es
    // pública: en una `@Public()` el guard termina acá, y sin esto eso viajaría
    // hacia los upstreams como si fuera el usuario.
    this.context?.remove(this.identityHeaders());

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = execution.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = bearerToken(header(request.headers, 'authorization'));
    if (token === undefined) {
      throw new UnauthorizedException();
    }

    const principal = resolvePrincipal(await this.claims(token), this.options);
    request.user = principal;

    // Con esto el id del usuario -y el rol, si se pidió- sale hacia cada
    // upstream sin que ningún punto de llamada lo pase, igual que el id de
    // correlación.
    this.context?.enrich(this.identity(principal));

    return true;
  }

  /** Las cabeceras que escribe la autenticación y nadie más. */
  private identityHeaders(): string[] {
    const { userIdHeader, roleHeader } = this.options;
    return roleHeader === undefined
      ? [userIdHeader]
      : [userIdHeader, roleHeader];
  }

  private identity(principal: Principal): Record<string, string> {
    const { userIdHeader, roleHeader } = this.options;
    const headers: Record<string, string> = { [userIdHeader]: principal.id };
    if (roleHeader !== undefined) {
      headers[roleHeader] = principal.role;
    }
    return headers;
  }

  private async claims(token: string): Promise<JwtClaims> {
    if (this.options.verify) {
      // La verificación puede fallar de muchas formas -firma, expiración,
      // emisor-, y ninguna de ellas es asunto del llamador: todas son 401.
      try {
        return await this.options.verify(token);
      } catch {
        throw new UnauthorizedException();
      }
    }

    const claims = decodeJwtClaims(token);
    if (claims === undefined) {
      throw new UnauthorizedException();
    }
    return claims;
  }
}
