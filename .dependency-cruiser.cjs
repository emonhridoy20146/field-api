/** Module boundaries (CLAUDE.md §2.5). Do not weaken these rules; fix the import instead. */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      comment: 'A module may import another module only through its index.ts.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/([^/]+)/', pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'] },
    },
    {
      name: 'core-is-independent',
      comment: 'core/ and shared/ never import business modules.',
      severity: 'error',
      from: { path: '^src/(core|shared)/', pathNot: '__tests__' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'only-app-lists-modules',
      comment: 'Manifests are imported only by src/app/register-modules.ts.',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/app/register-modules\\.ts$', '^src/modules/([^/]+)/'] },
      to: { path: '^src/modules/[^/]+/manifest\\.ts$' },
    },
    {
      name: 'models-stay-private',
      comment: "Nothing outside a module touches its models/ (not even through index.ts re-exports of other files).",
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/[^/]+/models/' },
    },
    { name: 'no-circular', severity: 'error', from: { path: '^src/' }, to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } } },
    { name: 'src-does-not-import-tests', severity: 'error', from: { path: '^src/', pathNot: '__tests__' }, to: { path: '^(test|mock-erp|scripts)/' } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js', '.json'], conditionNames: ['import', 'node', 'default'] },
  },
};
