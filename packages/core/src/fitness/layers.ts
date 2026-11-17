// The layers of core (design 5.2) as data: a top-level folder of
// `packages/core/src` and the folders, or single files, it may import from.
// Imports inside one folder are free but must stay acyclic; `ports` is the
// bottom layer. `@browser-link/shared` is allowed everywhere. Files at the
// root of `src/` (the package entry `index.ts`) may re-export any layer.
// A folder that is not listed here fails the fitness test until it is added.

export const LAYERS: Readonly<Record<string, readonly string[]>> = {
  tools: ['actions', 'flow', 'session', 'policies', 'support', 'inpage', 'ports'],
  actions: ['session', 'support', 'inpage', 'ports'],
  session: ['policies', 'support', 'inpage', 'ports'],
  flow: ['policies', 'support', 'inpage', 'ports'],
  policies: ['support/flow-limits.ts', 'ports'],
  support: ['inpage', 'ports'],
  inpage: [],
  ports: [],
};

/** The folder whose files are the package entry and may import any layer. */
export const ROOT_FOLDER = '.';
