// Synchronous reads; the adapter keeps the cache current. Only what core
// decides on: flow recording is extension-only.

export interface IdleSettings {
  idleTtlMinutes(): number;
}
