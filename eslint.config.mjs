// Root flat config. ESLint 9 searches ANCESTOR directories from the cwd, so
// this single file is what makes each package's `eslint src/**/*.ts` script
// resolve the shared rule set — without it the scripts fail outright.
export { default } from './eslint.config.base.mjs';
