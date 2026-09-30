import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// ADR-031: el módulo de errores no importa ningún framework web, y ése es el
// punto del cambio -el mismo caso de uso corre detrás de HTTP o de un
// consumidor de cola-. La regla de oxlint mira los imports de cada archivo de
// la carpeta; esto sigue además los que salen de ella, porque el módulo usa el
// sobre de `api-standard` y el contexto de `observability`, y un import de Nest
// agregado allá llegaría hasta acá sin que la regla lo vea.

const SRC = resolve(__dirname, '..');
const FORBIDDEN = /^(?:@nestjs\/|@fastify\/|express$|fastify$)/u;

// `import ... from`, `export ... from`, `import '...'`, `import('...')` y
// `require('...')`. Los `import type` cuentan: dejarían la dependencia en el
// .d.ts que publica el paquete.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu;

/** La ruta desde `src`, con barras normales en cualquier sistema. */
function display(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

function specifiersOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map(
    (match) => match[1] ?? '',
  );
}

function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const candidates = [`${base}.ts`, join(base, 'index.ts')];
  const found = candidates.find((candidate) => existsSync(candidate));

  if (found === undefined) {
    throw new Error(`Cannot resolve ${specifier} from ${from}`);
  }

  return found;
}

/**
 * Todos los archivos que alcanza el grafo de imports desde `entries`, y los
 * paquetes que importa cada uno.
 */
function walk(entries: readonly string[]): Map<string, string[]> {
  const packages = new Map<string, string[]>();
  const pending = [...entries];

  while (pending.length > 0) {
    const file = pending.pop() as string;

    if (packages.has(file)) {
      continue;
    }

    const specifiers = specifiersOf(file);
    packages.set(
      file,
      specifiers.filter((specifier) => !specifier.startsWith('.')),
    );

    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        pending.push(resolveRelative(file, specifier));
      }
    }
  }

  return packages;
}

function forbiddenImports(graph: Map<string, string[]>): string[] {
  return [...graph].flatMap(([file, packages]) =>
    packages
      .filter((name) => FORBIDDEN.test(name))
      .map((name) => `${display(file)} -> ${name}`),
  );
}

const MODULE_FILES = readdirSync(__dirname)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
  .map((name) => join(__dirname, name));

describe('the errors module', () => {
  it('reaches no web framework, not even through another module', () => {
    expect(forbiddenImports(walk(MODULE_FILES))).toEqual([]);
  });

  // Sin esto, el test de arriba podría pasar por no estar mirando nada.
  it('follows the imports that leave its folder', () => {
    const reached = [...walk(MODULE_FILES).keys()].map(display);

    expect(reached).toEqual(
      expect.arrayContaining([
        'errors/index.ts',
        'api-standard/api-responses.ts',
        'observability/request-context.storage.ts',
      ]),
    );
  });

  it('tells a file that does import Nest', () => {
    const filter = join(SRC, 'api', 'filters', 'all-exceptions.filter.ts');

    expect(forbiddenImports(walk([filter]))).toContain(
      'api/filters/all-exceptions.filter.ts -> @nestjs/common',
    );
  });
});
