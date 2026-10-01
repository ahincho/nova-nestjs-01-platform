import { errorItem } from './api-error';
import { ApiResponses } from './api-responses';

describe('ApiResponses.ok', () => {
  it('defaults to 200 and reports an empty error list', () => {
    expect(ApiResponses.ok({ id: 7 })).toEqual({
      success: true,
      status: 200,
      data: { id: 7 },
      errors: [],
    });
  });

  it('honours an explicit status', () => {
    expect(ApiResponses.ok('body', 202).status).toBe(202);
  });

  // `null` is a legitimate payload; only a failure means "there is no data".
  it('keeps a null payload as a success', () => {
    const response = ApiResponses.ok(null);
    expect(response.success).toBe(true);
    expect(response.data).toBeNull();
  });
});

describe('ApiResponses.created', () => {
  it('is a 201 success', () => {
    expect(ApiResponses.created({ id: 1 })).toEqual({
      success: true,
      status: 201,
      data: { id: 1 },
      errors: [],
    });
  });
});

describe('ApiResponses.error', () => {
  it('nulls the payload and carries the entries given', () => {
    const notFound = errorItem('NOT_FOUND', 'Student not found');

    expect(ApiResponses.error(404, notFound)).toEqual({
      success: false,
      status: 404,
      data: null,
      errors: [notFound],
    });
  });

  it('accepts a spread list of validation entries', () => {
    const errors = [
      errorItem('VALIDATION_ERROR', 'must be a number', 'periodId'),
      errorItem('VALIDATION_ERROR', 'must not be empty', 'studentId'),
    ];

    expect(ApiResponses.error(400, ...errors).errors).toHaveLength(2);
  });
});

describe('ApiResponses.errorOf', () => {
  it('derives the code from the status', () => {
    expect(ApiResponses.errorOf(404, 'Student not found').errors[0]).toEqual({
      code: 'NOT_FOUND',
      message: 'Student not found',
      field: null,
    });
  });

  it('lets the caller override the derived code', () => {
    const response = ApiResponses.errorOf(409, 'Already enrolled', {
      code: 'ALREADY_ENROLLED',
    });

    expect(response.errors[0]?.code).toBe('ALREADY_ENROLLED');
  });

  it('carries the offending field', () => {
    const response = ApiResponses.errorOf(400, 'must be a number', {
      field: 'periodId',
    });

    expect(response.errors[0]?.field).toBe('periodId');
  });
});

describe('ApiResponses.withMetadata', () => {
  it('adds the metadata and keeps the rest of the envelope', () => {
    const response = ApiResponses.withMetadata(
      ApiResponses.errorOf(404, 'Student not found'),
      { traceId: 'trace-1' },
    );

    expect(response).toEqual({
      success: false,
      status: 404,
      data: null,
      errors: [
        { code: 'NOT_FOUND', message: 'Student not found', field: null },
      ],
      metadata: { traceId: 'trace-1' },
    });
  });

  // El sobre recibido puede ser de alguien más: escribir sobre él haría que dos
  // respuestas compartieran la misma metadata.
  it('leaves the envelope it was given untouched', () => {
    const original = ApiResponses.errorOf(500, 'Internal server error');

    ApiResponses.withMetadata(original, { traceId: 'trace-1' });

    expect(original).not.toHaveProperty('metadata');
  });

  // Un cliente viejo no conoce `metadata`, y el interceptor tiene que seguir
  // reconociendo el sobre con ella.
  it('is still recognised as an envelope', () => {
    expect(
      ApiResponses.isApiResponse(
        ApiResponses.withMetadata(ApiResponses.errorOf(404, 'x'), {
          traceId: null,
        }),
      ),
    ).toBe(true);
  });
});

describe('ApiResponses.isApiResponse', () => {
  it('recognises an envelope this module built', () => {
    expect(ApiResponses.isApiResponse(ApiResponses.ok({ id: 1 }))).toBe(true);
    expect(ApiResponses.isApiResponse(ApiResponses.errorOf(404, 'x'))).toBe(
      true,
    );
  });

  // These are what a controller actually returns, and every one of them has to
  // be wrapped rather than passed through.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ok'],
    ['a number', 200],
    ['an array', [{ id: 1 }]],
    ['a plain object', { id: 1 }],
    ['an envelope missing errors', { success: true, status: 200, data: null }],
    [
      'an object whose errors is not an array',
      { success: true, status: 200, data: null, errors: 'none' },
    ],
    [
      'an object whose status is a string',
      { success: true, status: '200', data: null, errors: [] },
    ],
  ])('rejects %s', (_label, value) => {
    expect(ApiResponses.isApiResponse(value)).toBe(false);
  });
});
