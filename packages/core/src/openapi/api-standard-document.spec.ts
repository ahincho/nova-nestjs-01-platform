import { Controller, Get, type INestApplication } from '@nestjs/common';
import {
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import {
  NovaEnvelopeStandard,
  type ApiStandard,
  type ApiStandardDocs,
  type ApiWire,
} from '../api-standard';
import { applyApiStandard } from './api-standard-document';
import {
  API_RESPONSE_EXTENSION,
  ApiEnvelope,
  ApiEnvelopeSchema,
  ApiErrorItemSchema,
  ApiErrors,
} from './envelope';

class CourseResponse {
  @ApiProperty()
  id: string;
}

@Controller('courses')
class CoursesController {
  @Get()
  @ApiEnvelope(CourseResponse, { isArray: true })
  @ApiErrors(400)
  findAll(): CourseResponse[] {
    return [];
  }

  @Get(':id')
  @ApiEnvelope(CourseResponse, { description: 'El curso pedido' })
  @ApiErrors(404, 502)
  findOne(): CourseResponse {
    return new CourseResponse();
  }
}

/** Un estándar sin sobre, con los errores en RFC 7807. */
class ProblemStandard implements ApiStandard {
  readonly openapi: ApiStandardDocs = {
    components: {
      Problem: {
        type: 'object',
        properties: { title: { type: 'string' }, status: { type: 'number' } },
      },
    },
    success: (payload) => ({ schema: payload }),
    failure: (status) => ({
      contentType: 'application/problem+json',
      description: `problem ${status}`,
      schema: { $ref: '#/components/schemas/Problem' },
    }),
  };

  success(payload: unknown): ApiWire {
    return { body: payload };
  }

  failure(): ApiWire {
    return { body: null };
  }

  owns(): boolean {
    return false;
  }
}

/** Quita las marcas, que es lo único que el estándar por defecto debe tocar. */
function withoutIntent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutIntent);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== API_RESPONSE_EXTENSION)
        .map(([key, inner]) => [key, withoutIntent(inner)]),
    );
  }
  return value;
}

describe('applyApiStandard', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function freshDocument(): OpenAPIObject {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Test').setVersion('1.0.0').build(),
    );
  }

  // La propiedad que hace posible reemplazar el estándar sin romper a nadie:
  // con el de Nova, el documento es exactamente el que ya existía.
  it('changes nothing but the marks with the Nova envelope', () => {
    const document = freshDocument();
    const expected = withoutIntent(structuredClone(document));

    expect(applyApiStandard(document, new NovaEnvelopeStandard())).toEqual(
      expected,
    );
  });

  // El estándar escribe sus esquemas a mano para no depender de swagger. Si
  // se separaran de lo que swagger genera de las clases, el documento
  // cambiaría según quién lo arme.
  it('declares the same envelope schemas swagger builds from the classes', () => {
    const generated = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Test').setVersion('1.0.0').build(),
      { extraModels: [ApiEnvelopeSchema, ApiErrorItemSchema] },
    ).components?.schemas;

    const { components } = new NovaEnvelopeStandard().openapi;

    expect(components['ApiEnvelopeSchema']).toEqual(
      generated?.['ApiEnvelopeSchema'],
    );
    expect(components['ApiErrorItemSchema']).toEqual(
      generated?.['ApiErrorItemSchema'],
    );
  });

  describe('with another standard', () => {
    let document: OpenAPIObject;

    beforeAll(() => {
      document = applyApiStandard(freshDocument(), new ProblemStandard());
    });

    it('describes a success as the standard does', () => {
      const response = document.paths['/courses/{id}']?.get?.responses['200'];

      expect(response).toEqual({
        description: 'El curso pedido',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CourseResponse' },
          },
        },
      });
    });

    it('keeps a list a list', () => {
      const response = document.paths['/courses']?.get?.responses['200'];

      expect(JSON.stringify(response)).toContain(
        JSON.stringify({
          type: 'array',
          items: { $ref: '#/components/schemas/CourseResponse' },
        }),
      );
    });

    it('describes a failure in the content type and words of the standard', () => {
      const response = document.paths['/courses/{id}']?.get?.responses['404'];

      expect(response).toEqual({
        description: 'problem 404',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        },
      });
    });

    it('declares the components of the standard', () => {
      expect(document.components?.schemas).toHaveProperty('Problem');
      expect(document.components?.schemas).toHaveProperty('CourseResponse');
    });

    // Un documento que declara un sobre que ningún endpoint devuelve miente por
    // exceso: quien genere un cliente lo va a encontrar y a usar.
    it('drops the Nova envelope nothing refers to anymore', () => {
      expect(document.components?.schemas).not.toHaveProperty(
        'ApiEnvelopeSchema',
      );
      expect(document.components?.schemas).not.toHaveProperty(
        'ApiErrorItemSchema',
      );
    });

    it('leaves no mark behind', () => {
      expect(JSON.stringify(document)).not.toContain(API_RESPONSE_EXTENSION);
    });
  });

  // Un estándar puede reusar la entrada de error de Nova dentro de su propio
  // cuerpo; entonces sigue en uso y no se toca.
  it('keeps a Nova schema the standard still refers to', () => {
    class ReusingStandard extends ProblemStandard {
      override readonly openapi: ApiStandardDocs = {
        ...new ProblemStandard().openapi,
        components: {
          Problem: {
            type: 'object',
            properties: {
              errors: {
                type: 'array',
                items: { $ref: '#/components/schemas/ApiErrorItemSchema' },
              },
            },
          },
        },
      };
    }

    const document = applyApiStandard(freshDocument(), new ReusingStandard());

    expect(document.components?.schemas).toHaveProperty('ApiErrorItemSchema');
    expect(document.components?.schemas).not.toHaveProperty(
      'ApiEnvelopeSchema',
    );
  });
});
