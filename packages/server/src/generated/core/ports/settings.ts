// GENERATED from packages/core/src/ports/settings.ts. Do not edit.
// Synchronous reads; the adapter keeps the cache current. Only what core
// decides on: flow recording is extension-only.

export interface IdleSettings {
  idleTtlMinutes(): number;
}
