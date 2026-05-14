// lint-staged runs the value as a command per matched glob. When a value is
// a function returning a string, lint-staged treats it as a single command
// and does NOT append the file list — useful for whole-repo validators like
// `seams.js check`, which must scan the full manifest, not just staged files.

const seamsCheck = () => 'node knauf/scripts/seams.js check';

module.exports = {
  '*.{js,jsx,ts,tsx}': ['prettier --write', 'eslint --fix', 'eslint'],
  '*.json': ['prettier --write'],
  // Any change to an upstream-class file or to the seams manifest itself
  // must keep SEAMS.md in sync. Run as a single whole-repo check.
  'api/**/*.{js,jsx,ts,tsx,css}': seamsCheck,
  'client/**/*.{js,jsx,ts,tsx,css}': seamsCheck,
  'packages/{api,client,data-provider,data-schemas}/**/*.{js,jsx,ts,tsx,css}': seamsCheck,
  'Dockerfile*': seamsCheck,
  'SEAMS.md': seamsCheck,
};
