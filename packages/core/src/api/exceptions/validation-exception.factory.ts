import {
  ValidationException,
  type ValidationViolation,
} from './validation.exception';

// Vive con el resto del catálogo; se reexporta acá porque es donde siempre se
// importó.
export { VALIDATION_ERROR_CODE } from '../../api-standard/error-code';

/**
 * The shape of a `class-validator` `ValidationError`, declared structurally.
 *
 * Declaring it here rather than importing the class is what keeps this package
 * free of a runtime dependency on `class-validator`: an application using a
 * different validator can hand over the same shape and get the same response.
 */
export type ValidationErrorLike = {
  readonly property: string;
  readonly constraints?: Record<string, string>;
  readonly children?: readonly ValidationErrorLike[];
};

function toViolations(
  errors: readonly ValidationErrorLike[],
  parentPath = '',
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  for (const error of errors) {
    const path = parentPath
      ? parentPath + '.' + error.property
      : error.property;

    // Sin código: cómo se llama un fallo de validación es del catálogo del
    // estándar activo, no de esta fábrica.
    for (const message of Object.values(error.constraints ?? {})) {
      violations.push({ field: path, message });
    }

    // A nested DTO reports its own failures under `children`. Flattening them
    // with a dotted path is what lets the client point at `address.zipCode`
    // instead of at `address`.
    if (error.children && error.children.length > 0) {
      violations.push(...toViolations(error.children, path));
    }
  }

  return violations;
}

/**
 * Turns validation errors into a {@link ValidationException}.
 *
 * Wire it into the global pipe as the `exceptionFactory`, so a failed DTO comes
 * back with one entry per constraint, in the shape of the active standard.
 * `bootstrap()` already does.
 */
export function validationExceptionFactory(
  errors: readonly ValidationErrorLike[],
): ValidationException {
  return new ValidationException(toViolations(errors));
}
