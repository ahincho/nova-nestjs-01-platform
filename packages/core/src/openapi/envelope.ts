import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { statusToErrorCode } from '../api-standard';

/**
 * Un error dentro del sobre, descrito para el documento OpenAPI.
 *
 * Es una clase y no el tipo `ApiErrorItem` porque OpenAPI se genera leyendo
 * metadatos en tiempo de ejecución, y un `type` de TypeScript no deja ninguno.
 * Nunca se instancia: existe sólo para que el generador tenga qué leer.
 */
export class ApiErrorItemSchema {
  @ApiProperty({ example: 'NOT_FOUND' })
  code: string;

  @ApiProperty({ example: 'Course not found' })
  message: string;

  /**
   * `null` para todo lo que no sea un error de validación, nunca ausente: quien
   * lee la respuesta encuentra la clave en los dos casos.
   */
  @ApiProperty({ type: String, nullable: true, example: null })
  field: string | null;
}

/**
 * La `metadata` del sobre, descrita para el documento OpenAPI.
 */
export class ApiMetadataSchema {
  /**
   * El id que se puede citar al reportar la falla: el mismo de la línea de log.
   * El filtro global siempre lo pone; `null` sólo si otro serializador no lo
   * tiene.
   */
  @ApiProperty({
    type: String,
    nullable: true,
    example: '3f2b8c1e-5d4a-4f6b-9a7c-2e1d0b9f8a6c',
  })
  traceId: string | null;
}

/**
 * El sobre con el que contesta todo endpoint de Nova, con `data` sin resolver.
 *
 * `ApiEnvelope` es lo que le pone forma a `data` en cada operación. Documentar
 * el sobre importa porque **el interceptor envuelve la respuesta después de que
 * el controlador la devolvió**: sin esto el documento describe lo que devuelve
 * el método y no lo que sale por el cable, que es la clase de mentira que
 * después se paga generando un cliente.
 */
export class ApiEnvelopeSchema {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 200 })
  status: number;

  @ApiProperty({ nullable: true })
  data: unknown;

  @ApiProperty({ type: [ApiErrorItemSchema] })
  errors: ApiErrorItemSchema[];

  // Opcional porque sólo la traen los errores: una respuesta exitosa lleva el
  // id en la cabecera `x-request-id` y su cuerpo no cambió (ADR-031).
  @ApiPropertyOptional({
    type: ApiMetadataSchema,
    description: 'Presente en las respuestas de error.',
  })
  metadata?: ApiMetadataSchema;
}

export type ApiEnvelopeOptions = {
  /** Estado HTTP que documenta. Por defecto 200. */
  readonly status?: number;
  /** Qué significa esta respuesta. Aparece al lado del estado. */
  readonly description?: string;
  /** `data` es una lista de `dto` en vez de uno solo. */
  readonly isArray?: boolean;
};

/**
 * Documenta la respuesta de una operación: el sobre, con `data` resuelto a
 * `dto`.
 *
 * @example
 * @Get(':id')
 * @ApiEnvelope(CourseResponse)
 * @ApiErrors(404)
 * findOne(@Param('id') id: string) {
 *   return this.courses.findOne(id);
 * }
 */
export function ApiEnvelope<T extends Type<unknown>>(
  dto: T,
  options: ApiEnvelopeOptions = {},
): MethodDecorator & ClassDecorator {
  const item = { $ref: getSchemaPath(dto) };

  return applyDecorators(
    // Sin esto el `$ref` apunta a un esquema que el documento no declara, y la
    // interfaz lo muestra vacío en vez de fallar.
    ApiExtraModels(ApiEnvelopeSchema, dto),
    ApiResponse({
      status: options.status ?? 200,
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiEnvelopeSchema) },
          {
            properties: {
              data: options.isArray
                ? { type: 'array', items: item }
                : { ...item, nullable: true },
            },
          },
        ],
      },
    }),
  );
}

/**
 * Documenta los fallos de una operación con el mismo sobre, uno por estado.
 *
 * El código de error de cada uno sale de `statusToErrorCode`, que es la misma
 * función que usa el catálogo de errores de Nova en tiempo de ejecución.
 * Escribirlo a mano dejaría que el documento y el servicio dijeran cosas
 * distintas sin que nada avise. Un servicio que reemplaza el catálogo documenta
 * sus propios códigos.
 *
 * @example
 * @ApiErrors(400, 404)
 */
export function ApiErrors(
  ...statuses: readonly number[]
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(ApiEnvelopeSchema),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: statusToErrorCode(status),
        schema: {
          allOf: [
            { $ref: getSchemaPath(ApiEnvelopeSchema) },
            {
              // Un error siempre trae `metadata`, con el `traceId` que se cita
              // al reportarlo; el sobre base la declara opcional por los éxitos.
              required: ['metadata'],
              properties: {
                success: { type: 'boolean', example: false },
                status: { type: 'number', example: status },
                data: { nullable: true, example: null },
              },
            },
          ],
        },
      }),
    ),
  );
}
