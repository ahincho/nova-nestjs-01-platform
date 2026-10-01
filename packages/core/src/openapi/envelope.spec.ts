import { Controller, Get, type INestApplication } from '@nestjs/common';
import { ApiProperty, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { ApiEnvelope, ApiEnvelopeSchema, ApiErrors } from './envelope';
import type { OpenAPIObject } from '@nestjs/swagger';

class CourseResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;
}

@Controller('courses')
class CoursesController {
  @Get()
  @ApiEnvelope(CourseResponse, { isArray: true })
  findAll(): CourseResponse[] {
    return [];
  }

  @Get(':id')
  @ApiEnvelope(CourseResponse, { description: 'El curso pedido' })
  @ApiErrors(404)
  findOne(): CourseResponse {
    return new CourseResponse();
  }
}

// Se genera el documento de verdad en vez de leer los metadatos que dejan los
// decoradores: lo que importa no es qué clave se escribió, sino qué termina
// diciendo el JSON que alguien usa para generar un cliente.
describe('the envelope decorators', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Test').setVersion('1.0.0').build(),
      { extraModels: [ApiEnvelopeSchema] },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('declares the envelope schema the operations point at', () => {
    expect(document.components?.schemas).toHaveProperty('ApiEnvelopeSchema');
    expect(document.components?.schemas).toHaveProperty('ApiErrorItemSchema');
  });

  it('resolves data to the given dto', () => {
    const response = document.paths['/courses/{id}']?.get?.responses['200'];

    expect(JSON.stringify(response)).toContain(
      '#/components/schemas/CourseResponse',
    );
    expect(JSON.stringify(response)).toContain(
      '#/components/schemas/ApiEnvelopeSchema',
    );
  });

  it('carries the description through', () => {
    const response = document.paths['/courses/{id}']?.get?.responses['200'];

    expect(response).toMatchObject({ description: 'El curso pedido' });
  });

  it('makes data an array when the endpoint returns a list', () => {
    const response = document.paths['/courses']?.get?.responses['200'];
    const [, overrides] = (
      response as { content: Record<string, { schema: { allOf: unknown[] } }> }
    ).content['application/json']!.schema.allOf;

    expect(overrides).toMatchObject({
      properties: { data: { type: 'array' } },
    });
  });

  // El código sale de la misma función que usa el filtro de excepciones, así
  // que documento y comportamiento no se pueden separar.
  it('names the failure with the code the exception filter would use', () => {
    const response = document.paths['/courses/{id}']?.get?.responses['404'];

    expect(response).toMatchObject({ description: 'NOT_FOUND' });
  });

  // ADR-031: un error trae `metadata.traceId`, y el documento tiene que decir
  // que la trae; un éxito no, así que en el sobre base es opcional.
  it('declares the metadata of the envelope as optional', () => {
    const envelope = document.components?.schemas?.['ApiEnvelopeSchema'] as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(document.components?.schemas).toHaveProperty('ApiMetadataSchema');
    expect(envelope.properties).toHaveProperty('metadata');
    expect(envelope.required).not.toContain('metadata');
  });

  it('documents the metadata as present on a failure', () => {
    const response = document.paths['/courses/{id}']?.get?.responses['404'];

    expect(JSON.stringify(response)).toContain('"required":["metadata"]');
  });

  it('documents a failure as an envelope with no data', () => {
    const response = document.paths['/courses/{id}']?.get?.responses['404'];

    expect(JSON.stringify(response)).toContain(
      '#/components/schemas/ApiEnvelopeSchema',
    );
    expect(JSON.stringify(response)).toContain('"example":false');
  });
});
