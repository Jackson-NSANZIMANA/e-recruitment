import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// `ignores` must come FIRST and stand alone to act as a global ignore set;
// otherwise every rule below is also applied to dist/ and the generated
// drizzle output, which is both slow and meaningless.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.js', '**/*.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    // strictTypeChecked rules are TYPE-AWARE: without a parser project they do
    // not merely skip, they hard-error ("you have used a rule which requires
    // type information"). `projectService` lets typescript-eslint discover the
    // right tsconfig per file across the workspace, which is what a monorepo
    // with one tsconfig per package needs.
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports'
      }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error'
    }
  },
  {
    // THE PROJECT'S ACTUAL CONSOLE RULE, as enforced by
    // services/edge-gateway/selfcheck/verify-edge-hygiene.ts: "a raw console.*
    // outside main.ts and the audit adapter" is the violation. Composition
    // roots legitimately print boot and shutdown lines before any logging sink
    // exists, and the audit adapters ARE the sink. Linting those as errors
    // would have pushed 62 correct lines toward a workaround, so the linter is
    // aligned to the architecture instead of the architecture to the linter.
    files: ['**/src/main.ts', '**/src/adapters/*audit-logger*.ts'],
    rules: { 'no-console': 'off' }
  },
  {
    // Proofs and one-shot operator scripts are console programs by definition:
    // their stdout IS the artefact. They are also outside every tsconfig, so
    // type-aware rules cannot run on them at all.
    ...tseslint.configs.disableTypeChecked,
    files: ['**/selfcheck/**/*.ts', '**/scripts/**/*.ts'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    }
  }
);
