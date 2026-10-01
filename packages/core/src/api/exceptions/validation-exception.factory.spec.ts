import {
  VALIDATION_ERROR_CODE,
  validationExceptionFactory,
  type ValidationErrorLike,
} from './validation-exception.factory';
import { ValidationException } from './validation.exception';

describe('validationExceptionFactory', () => {
  // Sin código: cómo se nombra un fallo de validación lo decide el catálogo
  // del estándar activo, así que la fábrica sólo dice qué campo y por qué.
  it('reports one violation per constraint, each naming its field', () => {
    const errors: ValidationErrorLike[] = [
      { property: 'periodId', constraints: { isInt: 'must be an integer' } },
      {
        property: 'studentId',
        constraints: { isNotEmpty: 'must not be empty' },
      },
    ];

    const exception = validationExceptionFactory(errors);

    expect(exception).toBeInstanceOf(ValidationException);
    expect(exception.violations).toEqual([
      { field: 'periodId', message: 'must be an integer' },
      { field: 'studentId', message: 'must not be empty' },
    ]);
  });

  it('reports every constraint of a single field', () => {
    const errors: ValidationErrorLike[] = [
      {
        property: 'email',
        constraints: {
          isEmail: 'must be an email',
          maxLength: 'must be shorter than 80 characters',
        },
      },
    ];

    expect(validationExceptionFactory(errors).violations).toHaveLength(2);
  });

  // Without the dotted path the client is told "address is invalid" and has no
  // way to highlight the input that actually failed.
  it('flattens a nested DTO into a dotted path', () => {
    const errors: ValidationErrorLike[] = [
      {
        property: 'address',
        children: [
          {
            property: 'zipCode',
            constraints: { isPostalCode: 'invalid code' },
          },
        ],
      },
    ];

    expect(validationExceptionFactory(errors).violations).toEqual([
      { field: 'address.zipCode', message: 'invalid code' },
    ]);
  });

  it('walks more than one level of nesting', () => {
    const errors: ValidationErrorLike[] = [
      {
        property: 'student',
        children: [
          {
            property: 'address',
            children: [
              {
                property: 'city',
                constraints: { isString: 'must be a string' },
              },
            ],
          },
        ],
      },
    ];

    expect(validationExceptionFactory(errors).violations[0]?.field).toBe(
      'student.address.city',
    );
  });

  it('produces an empty list when nothing carries a constraint', () => {
    expect(validationExceptionFactory([]).violations).toEqual([]);
  });
});

describe('ValidationException', () => {
  // `validationErrors` queda por compatibilidad con quien lo leía, y sigue
  // diciendo lo mismo que antes: el sobre de Nova, con su código.
  it('still reads as the Nova envelope entries through the old name', () => {
    const exception = new ValidationException([
      { field: 'periodId', message: 'must be an integer' },
      { field: 'name', message: 'is taken', code: 'NAME_TAKEN' },
    ]);

    expect(exception.validationErrors).toEqual([
      {
        code: VALIDATION_ERROR_CODE,
        message: 'must be an integer',
        field: 'periodId',
      },
      { code: 'NAME_TAKEN', message: 'is taken', field: 'name' },
    ]);
  });
});
