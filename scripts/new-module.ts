/**
 * `pnpm new:module <name>`: copy templates/module to src/modules/<name> and fill in the names.
 * It does not register the module: add it to src/app/register-modules.ts yourself (the only list),
 * then work through the module-add checklist in CLAUDE.md §5.
 */
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = process.argv[2] ?? '';
if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) {
  console.error('usage: pnpm new:module <kebab-case-name>');
  process.exit(1);
}
if (name === 'microfinance') {
  console.error('microfinance is reserved (FR-MF-001) and must not be implemented.');
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'src/modules', name);
if (existsSync(target)) {
  console.error(`src/modules/${name} already exists`);
  process.exit(1);
}
const camel = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const pascal = camel[0]!.toUpperCase() + camel.slice(1);
cpSync(join(root, 'templates/module'), target, { recursive: true });
const fill = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) fill(p);
    else
      writeFileSync(
        p,
        readFileSync(p, 'utf8')
          .replaceAll('__name__', name)
          .replaceAll('__camel__', camel)
          .replaceAll('__Pascal__', pascal)
          .replaceAll('__collection__', name.replace(/-/g, '_')),
      );
  }
};
fill(target);
console.log(
  `created src/modules/${name}. Next: openapi.yaml → manifest permissions → register-modules.ts → tests → docs (CLAUDE.md §5).`,
);
