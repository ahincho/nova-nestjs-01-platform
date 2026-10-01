import { ApplicationError } from './application-error';
import { DomainError } from './domain-error';
import { DomainErrorType } from './error-type';
import { InfrastructureError } from './infrastructure-error';
import type { NovaError } from './nova-error';
import { NovaErrorStatusMapper } from './nova-error-status-mapper';
import { PlatformError } from './platform-error';

describe('NovaErrorStatusMapper', () => {
  const mapper = new NovaErrorStatusMapper();

  // La tabla de ADR-031, fila por fila.
  it.each<[string, NovaError, number]>([
    ['domain NOT_FOUND', DomainError.notFound('x'), 404],
    ['domain CONFLICT', DomainError.conflict('x'), 409],
    ['domain RULE_VIOLATION', DomainError.ruleViolation('x'), 422],
    ['application INVALID_INPUT', ApplicationError.invalidInput('x'), 400],
    ['application CONFLICT', ApplicationError.conflict('x'), 409],
    ['application UNPROCESSABLE', ApplicationError.unprocessable('x'), 422],
    ['application UNAUTHENTICATED', ApplicationError.unauthenticated('x'), 401],
    ['application FORBIDDEN', ApplicationError.forbidden('x'), 403],
    ['application RATE_LIMITED', ApplicationError.rateLimited('x'), 429],
    ['infrastructure UNAVAILABLE', InfrastructureError.unavailable('u'), 503],
    ['infrastructure TIMEOUT', InfrastructureError.timeout('u'), 504],
    ['infrastructure BAD_GATEWAY', InfrastructureError.badGateway('u'), 502],
    ['platform INTERNAL', PlatformError.internal('x'), 500],
  ])('maps %s to %i', (_row, error, status) => {
    expect(mapper.statusOf(error)).toBe(status);
  });

  // Un tipo fuera de la tabla sólo llega desde código sin tipos. Un 500 es lo
  // único que no le promete nada al cliente.
  it('answers 500 for a type the table does not know', () => {
    const stray = new DomainError('TYPO' as DomainErrorType, 'x');

    expect(mapper.statusOf(stray)).toBe(500);
  });
});
