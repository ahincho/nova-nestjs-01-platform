import { Layer } from '../errors/layer';
import type { ApiFailure } from './api-standard';
import { ApiResponses } from './api-responses';
import { INTERNAL_ERROR_CODE, VALIDATION_ERROR_CODE } from './error-code';
import {
  ENVELOPE_SCHEMA_NAME,
  ERROR_ITEM_SCHEMA_NAME,
  METADATA_SCHEMA_NAME,
  NovaEnvelopeStandard,
} from './nova-envelope.standard';

function failure(overrides: Partial<ApiFailure> = {}): ApiFailure {
  return {
    status: 404,
    kind: 'request',
    layer: Layer.APPLICATION,
    traceId: 'trace-1',
    retryAfter: undefined,
    errors: [{ code: undefined, message: 'Course not found', field: null }],
    ...overrides,
  };
}

describe('NovaEnvelopeStandard', () => {
  const standard = new NovaEnvelopeStandard();

  it('wraps a success in the envelope', () => {
    expect(standard.success({ id: 7 }, 201)).toEqual({
      body: { success: true, status: 201, data: { id: 7 }, errors: [] },
    });
  });

  // Sin `contentType`: el sobre es JSON, y lo pone la plataforma.
  it('leaves the content type to the platform', () => {
    expect(standard.success({}, 200).contentType).toBeUndefined();
    expect(standard.failure(failure()).contentType).toBeUndefined();
  });

  it('names a failure with no code of its own from the catalog', () => {
    expect(standard.failure(failure()).body).toEqual({
      success: false,
      status: 404,
      data: null,
      errors: [{ code: 'NOT_FOUND', message: 'Course not found', field: null }],
      metadata: { traceId: 'trace-1' },
    });
  });

  it('keeps the code the thrower chose', () => {
    const body = standard.failure(
      failure({
        errors: [
          {
            code: 'COURSE_NOT_FOUND',
            message: 'Course not found',
            field: null,
          },
        ],
      }),
    ).body;

    expect(body).toMatchObject({ errors: [{ code: 'COURSE_NOT_FOUND' }] });
  });

  it('names every violation of a validation failure', () => {
    const body = standard.failure(
      failure({
        status: 400,
        kind: 'validation',
        errors: [
          { code: undefined, message: 'must be an integer', field: 'periodId' },
          { code: undefined, message: 'must not be empty', field: 'name' },
        ],
      }),
    ).body;

    expect(body).toMatchObject({
      status: 400,
      errors: [
        { code: VALIDATION_ERROR_CODE, field: 'periodId' },
        { code: VALIDATION_ERROR_CODE, field: 'name' },
      ],
    });
  });

  // ADR-031: cada 5xx con nombre propio, para que el cliente sepa si reintentar.
  it('names a 5xx by its own code', () => {
    const body = standard.failure(
      failure({
        status: 502,
        kind: 'internal',
        errors: [
          { code: undefined, message: 'Internal server error', field: null },
        ],
      }),
    ).body;

    expect(body).toMatchObject({ errors: [{ code: 'BAD_GATEWAY' }] });
  });

  // ADR-031: el id que se cita al reportar la falla viaja también en el cuerpo.
  it('carries the trace id in the metadata of a failure', () => {
    expect(standard.failure(failure()).body).toMatchObject({
      metadata: { traceId: 'trace-1' },
    });
  });

  it('recognises only its own envelope', () => {
    expect(standard.owns(ApiResponses.ok({ id: 7 }))).toBe(true);
    expect(standard.owns({ id: 7 })).toBe(false);
    expect(standard.owns(undefined)).toBe(false);
  });

  describe('with codes of its own', () => {
    const own = new NovaEnvelopeStandard({
      codes: {
        byStatus: { 502: 'UPSTREAM_FAILED' },
        validation: 'INVALID_INPUT',
      },
    });

    // El catálogo propio se suma al de Nova: nombrar un 502 no obliga a volver
    // a escribir los demás.
    it('adds to the Nova catalog instead of replacing it', () => {
      expect(own.catalog.byStatus[502]).toBe('UPSTREAM_FAILED');
      expect(own.catalog.byStatus[404]).toBe('NOT_FOUND');
      expect(own.catalog.internal).toBe(INTERNAL_ERROR_CODE);
    });

    it('answers with its own names', () => {
      const body = own.failure(
        failure({
          status: 502,
          kind: 'internal',
          errors: [
            { code: undefined, message: 'Internal server error', field: null },
          ],
        }),
      ).body;

      expect(body).toMatchObject({
        errors: [{ code: 'UPSTREAM_FAILED', message: 'Internal server error' }],
      });
    });

    it('documents a failure with its own names', () => {
      expect(own.openapi.failure(502).description).toBe('UPSTREAM_FAILED');
    });

    it('leaves the default untouched', () => {
      expect(standard.catalog.byStatus[502]).toBe('BAD_GATEWAY');
    });
  });

  describe('openapi', () => {
    it('declares the envelope and its error entry', () => {
      expect(Object.keys(standard.openapi.components)).toEqual([
        ERROR_ITEM_SCHEMA_NAME,
        METADATA_SCHEMA_NAME,
        ENVELOPE_SCHEMA_NAME,
      ]);
    });

    it('puts a list payload as it is and an object as nullable', () => {
      const list = { type: 'array', items: { $ref: '#/x' } };

      expect(JSON.stringify(standard.openapi.success(list).schema)).toContain(
        JSON.stringify({ data: list }),
      );
      expect(
        JSON.stringify(standard.openapi.success({ $ref: '#/x' }).schema),
      ).toContain(JSON.stringify({ data: { $ref: '#/x', nullable: true } }));
    });

    it('describes a failure by the code its catalog gives it', () => {
      expect(standard.openapi.failure(404).description).toBe('NOT_FOUND');
      expect(standard.openapi.failure(504).description).toBe('GATEWAY_TIMEOUT');
      expect(standard.openapi.failure(501).description).toBe(
        INTERNAL_ERROR_CODE,
      );
    });
  });
});
