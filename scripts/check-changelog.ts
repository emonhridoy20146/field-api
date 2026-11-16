/**
 * CI guard (CLAUDE.md §4.6): when src/ changed against the base branch, docs/CHANGELOG.md must change too.
 * Usage: tsx scripts/check-changelog.ts <base-ref>   (default origin/main)
 */
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'origin/main';
if (!/^[\w./-]+$/.test(base)) throw new Error('invalid base ref');
const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const srcChanged = changed.some((f) => f.startsWith('src/'));
if (srcChanged && !changed.includes('docs/CHANGELOG.md')) {
  console.error('src/ changed but docs/CHANGELOG.md did not. Add a changelog entry.');
  process.exit(1);
}
console.log(srcChanged ? 'changelog updated with src changes' : 'no src changes');
