import type { OpenAPIObject } from '@nestjs/swagger';
import {
  ENVELOPE_SCHEMA_NAME,
  ERROR_ITEM_SCHEMA_NAME,
  METADATA_SCHEMA_NAME,
  type ApiStandard,
} from '../api-standard';
import { API_RESPONSE_EXTENSION, type ApiResponseIntent } from './envelope';

const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

type MediaLike = { schema?: Record<string, unknown> };

type ResponseLike = {
  description?: string;
  content?: Record<string, MediaLike>;
};

type OperationLike = { responses?: Record<string, ResponseLike> };

function intentOf(response: ResponseLike): ApiResponseIntent | undefined {
  for (const media of Object.values(response.content ?? {})) {
    const intent = media.schema?.[API_RESPONSE_EXTENSION];
    if (intent !== undefined) {
      return intent as ApiResponseIntent;
    }
  }
  return undefined;
}

/**
 * Quita un esquema del sobre de Nova que nadie referencia.
 *
 * Con otro estándar activo, el sobre de Nova queda declarado pero sin uso -los
 * decoradores lo registran igual- y un documento que declara un cuerpo que
 * ningún endpoint devuelve miente por exceso. Se busca en el documento sin el
 * propio esquema, para que la referencia del sobre a la entrada de error no
 * cuente como uso de la entrada.
 */
function dropUnreferenced(document: OpenAPIObject, name: string): void {
  const schemas = document.components?.schemas;
  if (schemas === undefined || !(name in schemas)) {
    return;
  }

  const { [name]: _own, ...others } = schemas;
  const rest = {
    ...document,
    components: { ...document.components, schemas: others },
  };

  if (!JSON.stringify(rest).includes(`"#/components/schemas/${name}"`)) {
    Reflect.deleteProperty(schemas, name);
  }
}

/**
 * Completa el documento con el estándar activo.
 *
 * Resuelve cada marca que dejaron `@ApiEnvelope` y `@ApiErrors` pidiéndole al
 * estándar su esquema, agrega los componentes que el estándar declara y quita
 * los del sobre de Nova cuando ya no los usa nadie. Modifica el documento y lo
 * devuelve.
 *
 * Con el sobre de Nova el resultado es el mismo documento que escribieron los
 * decoradores, sin las marcas: el estándar por defecto no cambia nada.
 */
export function applyApiStandard(
  document: OpenAPIObject,
  standard: ApiStandard,
): OpenAPIObject {
  for (const path of Object.values(document.paths)) {
    for (const method of METHODS) {
      const operation = path[method] as OperationLike | undefined;

      for (const response of Object.values(operation?.responses ?? {})) {
        const intent = intentOf(response);
        if (intent === undefined) {
          continue;
        }

        const described =
          intent.response === 'success'
            ? standard.openapi.success(intent.payload)
            : standard.openapi.failure(intent.status);

        response.content = {
          [described.contentType ?? 'application/json']: {
            schema: { ...described.schema },
          },
        };

        // La de un éxito la escribió la operación y se respeta; un fallo no
        // trae una propia, así que la pone el catálogo del estándar.
        if (
          intent.response === 'failure' &&
          described.description !== undefined
        ) {
          response.description = described.description;
        }
      }
    }
  }

  document.components = {
    ...document.components,
    schemas: {
      ...document.components?.schemas,
      ...standard.openapi.components,
    },
  };

  // El sobre antes que la entrada y que la metadata: esas dos sólo quedan sin
  // uso cuando el sobre, que las referencia, ya se fue.
  for (const name of [
    ENVELOPE_SCHEMA_NAME,
    METADATA_SCHEMA_NAME,
    ERROR_ITEM_SCHEMA_NAME,
  ]) {
    if (!(name in standard.openapi.components)) {
      dropUnreferenced(document, name);
    }
  }

  return document;
}
