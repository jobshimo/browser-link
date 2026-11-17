// GENERATED from packages/core/src/tools/requirement.ts. Do not edit.
/**
 * What a tool handler may require from its transport (design 3.3), and the
 * dependencies that satisfy each requirement. A handler's `deps` is the
 * `Pick` of exactly what it `requires`, plus what every transport gives:
 * the clock, and the dialog watch where the transport tracks dialogs (the
 * extension; read-only and transitional until slice 12, design revision 8).
 * Requirements join with the first handler that needs them: slice 10 has
 * the page's evaluator, pointer and settle wait; slice 11 adds the keyboard.
 */
import type { Clock } from '../ports/clock.js';
import type { Evaluator, Keyboard, Pointer, Settler } from '../ports/page-driver.js';
import type { DialogWatch } from '../session/page-driver.js';

export interface RequirementDeps {
  evaluator: Evaluator;
  keyboard: Keyboard;
  pointer: Pointer;
  settler: Settler;
}

export type Requirement = keyof RequirementDeps;

/** What every transport gives besides its requirements. */
export interface CommonDeps {
  clock: Clock;
  dialogs?: DialogWatch;
}

/** Every dependency a transport gives the registry. */
export interface ToolDeps extends RequirementDeps, CommonDeps {}

/** The deps of a handler that requires `R`. */
export type DepsFor<R extends Requirement> = Pick<RequirementDeps, R> & CommonDeps;
