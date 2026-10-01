import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import {
  ApiResponses,
  NovaEnvelopeStandard,
  type ApiStandard,
  type ApiWire,
} from '../../api-standard';
import { lastValueFrom, of } from 'rxjs';
import { ResponseWrapperInterceptor } from './response-wrapper.interceptor';

type ContextOptions = {
  statusCode?: number;
  type?: 'http' | 'rpc';
  headers?: Record<string, string>;
};

function contextDouble({
  statusCode = 200,
  type = 'http',
  headers = {},
}: ContextOptions = {}): ExecutionContext {
  const response = {
    statusCode,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };

  return {
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ExecutionContext;
}

/**
 * Un estándar que no envuelve: contesta el payload tal cual, en otro
 * `Content-Type`, y reconoce como propio lo que trae una marca.
 */
class BareStandard implements ApiStandard {
  readonly openapi = new NovaEnvelopeStandard().openapi;

  success(payload: unknown, status: number): ApiWire {
    return {
      contentType: 'application/vnd.example+json',
      body: { payload, status },
    };
  }

  failure(): ApiWire {
    return { body: null };
  }

  owns(payload: unknown): boolean {
    return typeof payload === 'object' && payload !== null && 'own' in payload;
  }
}

function handlerDouble(payload: unknown): CallHandler<unknown> {
  return { handle: () => of(payload) };
}

function reflectorDouble(skip?: boolean): Reflector {
  return {
    getAllAndOverride: vi.fn().mockReturnValue(skip),
  } as unknown as Reflector;
}

describe('ResponseWrapperInterceptor', () => {
  it('wraps a plain payload, reading the status off the response', async () => {
    const interceptor = new ResponseWrapperInterceptor(reflectorDouble());

    const result = await lastValueFrom(
      interceptor.intercept(
        contextDouble({ statusCode: 201 }),
        handlerDouble({ id: 7 }),
      ),
    );

    expect(result).toEqual({
      success: true,
      status: 201,
      data: { id: 7 },
      errors: [],
    });
  });

  it('wraps an undefined payload rather than dropping it', async () => {
    const interceptor = new ResponseWrapperInterceptor(reflectorDouble());

    const result = await lastValueFrom(
      interceptor.intercept(contextDouble(), handlerDouble(undefined)),
    );

    expect(ApiResponses.isApiResponse(result)).toBe(true);
  });

  // Wrapping twice produces { data: { data: ... } }, which no client reads.
  it('leaves an envelope the handler already built untouched', async () => {
    const envelope = ApiResponses.errorOf(404, 'Student not found');
    const interceptor = new ResponseWrapperInterceptor(reflectorDouble());

    const result = await lastValueFrom(
      interceptor.intercept(contextDouble(), handlerDouble(envelope)),
    );

    expect(result).toBe(envelope);
  });

  it('passes through when the handler is marked to skip', async () => {
    const payload = { status: 'ok' };
    const interceptor = new ResponseWrapperInterceptor(reflectorDouble(true));

    const result = await lastValueFrom(
      interceptor.intercept(contextDouble(), handlerDouble(payload)),
    );

    expect(result).toBe(payload);
  });

  // A microservice payload is not an HTTP body, and there is no status to read.
  it('passes through outside an HTTP context', async () => {
    const payload = { event: 'student.enrolled' };
    const interceptor = new ResponseWrapperInterceptor(reflectorDouble());

    const result = await lastValueFrom(
      interceptor.intercept(
        contextDouble({ type: 'rpc' }),
        handlerDouble(payload),
      ),
    );

    expect(result).toBe(payload);
  });

  describe('with another standard', () => {
    it('answers with the body and the content type of the standard', async () => {
      const headers: Record<string, string> = {};
      const interceptor = new ResponseWrapperInterceptor(
        reflectorDouble(),
        new BareStandard(),
      );

      const result = await lastValueFrom(
        interceptor.intercept(
          contextDouble({ statusCode: 201, headers }),
          handlerDouble({ id: 7 }),
        ),
      );

      expect(result).toEqual({ payload: { id: 7 }, status: 201 });
      expect(headers).toEqual({
        'Content-Type': 'application/vnd.example+json',
      });
    });

    // Qué cuenta como «ya formateado» lo sabe el estándar: el sobre de Nova
    // armado a mano no es un cuerpo de este, y se trata como cualquier payload.
    it('asks the standard whether a body is already its own', async () => {
      const interceptor = new ResponseWrapperInterceptor(
        reflectorDouble(),
        new BareStandard(),
      );
      const own = { own: true };

      const kept = await lastValueFrom(
        interceptor.intercept(contextDouble(), handlerDouble(own)),
      );
      const envelope = ApiResponses.ok({ id: 7 });
      const wrapped = await lastValueFrom(
        interceptor.intercept(contextDouble(), handlerDouble(envelope)),
      );

      expect(kept).toBe(own);
      expect(wrapped).toEqual({ payload: envelope, status: 200 });
    });

    // Las dos reglas que no son del estándar siguen valiendo con cualquiera.
    it('still leaves out a skipped handler and a non-HTTP context', async () => {
      const payload = { status: 'ok' };

      const skipped = await lastValueFrom(
        new ResponseWrapperInterceptor(
          reflectorDouble(true),
          new BareStandard(),
        ).intercept(contextDouble(), handlerDouble(payload)),
      );
      const rpc = await lastValueFrom(
        new ResponseWrapperInterceptor(
          reflectorDouble(),
          new BareStandard(),
        ).intercept(contextDouble({ type: 'rpc' }), handlerDouble(payload)),
      );

      expect(skipped).toBe(payload);
      expect(rpc).toBe(payload);
    });
  });
});
