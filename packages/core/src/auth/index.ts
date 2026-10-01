export { NovaAuthGuard, type AuthenticatedRequest } from './auth.guard';
export { CurrentUser } from './current-user.decorator';
export { bearerToken, decodeJwtClaims, readClaim, type JwtClaims } from './jwt';
export { NovaAuthModule } from './nova-auth.module';
export { resolvePrincipal, type Principal } from './principal';
export { IS_PUBLIC, Public } from './public.decorator';
export {
  AUTH_OPTIONS,
  DEFAULT_ID_CLAIM,
  DEFAULT_IGNORED_ROLES,
  DEFAULT_IGNORED_ROLE_PREFIXES,
  DEFAULT_ROLES_CLAIM,
  DEFAULT_USER_ID_HEADER,
  normalizeUserId,
  resolveAuthOptions,
  trimUserId,
  type NovaAuthModuleOptions,
  type ResolvedAuthOptions,
} from './tokens';
