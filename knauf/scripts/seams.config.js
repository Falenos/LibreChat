// @ts-check
//
// seams.config.js — single source for classification policy
//
// This file is pure data. It declares which paths are upstream-class (require
// [knauf] markers), knauf-only (additive), config, meta, or ignored. Editing
// policy here is faster and safer than editing the classifier logic, and it
// gives a one-page view of the fork-management contract for new contributors.
//
// Schema:
//   knaufDirs         path prefixes that are net-new Knauf code (knauf-only class)
//   configFiles       exact file paths that are Knauf-controlled configuration
//   upstreamPrefixes  path prefixes that come from upstream LibreChat
//   metaPrefixes      path prefixes for tooling/CI (not tracked as seams)
//   ignorePrefixes    path prefixes that are never code-of-record (never tracked)
//   lockfiles         exact filenames that are dependency lockfiles
//   rootMetaFiles     exact root-level filenames that are repo glue
//   sourceExtensions  file extensions that participate in marker scanning
//   dockerfileRe      basename regex for upstream-class Dockerfiles
//
// Anything not matching any of the above falls through to `meta` — safe
// default, never triggers the [knauf]-marker requirement.

'use strict';

module.exports = {
  knaufDirs: [
    'api/knauf/',
    'api/server/routes/knauf/',
    'client/src/knauf/',
    'packages/knauf/',
    'assets/knauf/',
  ],

  configFiles: new Set(['librechat.yaml', 'docker-compose.override.yml']),

  upstreamPrefixes: [
    'api/',
    'client/',
    'packages/api/',
    'packages/client/',
    'packages/data-provider/',
    'packages/data-schemas/',
  ],

  metaPrefixes: ['.github/', '.husky/', '.vscode/', '.do/', '.devcontainer/'],

  // Top-level directories that are never code-of-record. Tested as prefix-match
  // *and* with the special `/node_modules/` substring rule in classify.js for
  // nested-workspace node_modules.
  ignorePrefixes: ['dist/', 'build/', '.turbo/', '.git/'],

  lockfiles: new Set(['bun.lock', 'package-lock.json', 'yarn.lock']),

  rootMetaFiles: new Set([
    'package.json',
    'turbo.json',
    '.prettierrc',
    '.gitignore',
    '.gitattributes',
    '.nvmrc',
    '.dockerignore',
    'LICENSE',
  ]),

  sourceExtensions: new Set(['.js', '.cjs', '.jsx', '.ts', '.tsx', '.css']),

  // Dockerfiles have no standard extension; match by base name.
  // Matches: `Dockerfile`, `Dockerfile.multi`, `Dockerfile.dev`, etc.
  dockerfileRe: /^Dockerfile(\..*)?$/,
};
