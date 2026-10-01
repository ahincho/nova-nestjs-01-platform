import {
  Inject,
  Injectable,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NovaEnvelopeStandard, type ApiStandard } from '../../api-standard';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SKIP_RESPONSE_WRAPPER } from '../decorators/skip-response-wrapper.decorator';
import { API_STANDARD } from '../tokens';

type HttpResponseLike = {
  readonly statusCode?: number;
  setHeader?(name: string, value: string): unknown;
};

/**
 * Le da a lo que devuelve un handler la forma del estándar activo.
 *
 * Registered globally by `ApiStandardModule.forRoot()`, so a controller returns
 * its domain object and never builds the envelope itself.
 *
 * Lo que decide este interceptor es **qué** pasa por el estándar; **cómo** se
 * ve lo decide el estándar. Por eso las tres salidas de abajo son del núcleo y
 * ningún estándar las cambia.
 */
@Injectable()
export class ResponseWrapperInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    // Opcional para que instanciarlo a mano, como antes de que el estándar se
    // pudiera reemplazar, siga contestando con el sobre de Nova.
    @Optional()
    @Inject(API_STANDARD)
    private readonly standard: ApiStandard = new NovaEnvelopeStandard(),
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    // A microservice or websocket handler has no HTTP response to read a status
    // from, and its payload is not an HTTP body. Wrapping it would corrupt the
    // message.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const skip = this.reflector.getAllAndOverride<boolean | undefined>(
      SKIP_RESPONSE_WRAPPER,
      [context.getHandler(), context.getClass()],
    );

    if (skip === true) {
      return next.handle();
    }

    return next.handle().pipe(
      map((payload: unknown) => {
        // A handler that built its own body - typically to report a status the
        // framework cannot infer - is left alone rather than wrapped twice. Si
        // es del estándar lo sabe el estándar, no este interceptor.
        if (this.standard.owns(payload)) {
          return payload;
        }

        const response = context.switchToHttp().getResponse<HttpResponseLike>();
        const wire = this.standard.success(payload, response.statusCode ?? 200);

        // Antes de que la plataforma serialice: Express sólo pone
        // `application/json` cuando nadie puso otro.
        if (wire.contentType !== undefined) {
          response.setHeader?.('Content-Type', wire.contentType);
        }

        return wire.body;
      }),
    );
  }
}
