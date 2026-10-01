import { BadRequestException } from '@nestjs/common';
import { errorItem, type ApiErrorItem } from '../../api-standard';
import { VALIDATION_ERROR_CODE } from '../../api-standard/error-code';

/**
 * Una restricción de la entrada que no se cumplió.
 *
 * Es neutra a propósito: dice qué campo falló y por qué, y deja que el estándar
 * activo decida cómo se escribe. El sobre de Nova la convierte en una entrada
 * con `VALIDATION_ERROR`; otro estándar puede hacer otra cosa.
 */
export type ValidationViolation = {
  /** El campo, con ruta punteada si está anidado. */
  readonly field: string | null;

  readonly message: string;

  /** Un código propio. Omitirlo deja que el estándar ponga el de su catálogo. */
  readonly code?: string;
};

/**
 * A 400 carrying one violation per failed constraint, each naming its field.
 *
 * A plain `BadRequestException` collapses every constraint into a single
 * string, so a form cannot tell which input to highlight.
 */
export class ValidationException extends BadRequestException {
  constructor(readonly violations: readonly ValidationViolation[]) {
    super('Validation failed');
  }

  /**
   * Las violaciones con la forma del sobre de Nova.
   *
   * @deprecated Leer {@link ValidationException.violations}. Esto es lo que
   * contestaba el sobre de Nova, y con otro estándar activo no es lo que sale
   * por el cable.
   */
  get validationErrors(): readonly ApiErrorItem[] {
    return this.violations.map((violation) =>
      errorItem(
        violation.code ?? VALIDATION_ERROR_CODE,
        violation.message,
        violation.field,
      ),
    );
  }
}
