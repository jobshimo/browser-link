// GENERATED from packages/core/src/tools/requirement.ts. Do not edit.
/**
 * What a tool handler may require from its transport (design 3.3), and the
 * dependencies that satisfy each requirement. A handler's `deps` is the
 * `Pick` of exactly what it `requires`, plus the clock every transport has.
 * Requirements join with the first handler that needs them: slice 10 has
 * the page's evaluator, pointer and settle wait.
 */
import type { Clock } from '../ports/clock.js';
import type { Evaluator, Pointer, Settler } from '../ports/page-driver.js';

export interface RequirementDeps {
  evaluator: Evaluator;
  pointer: Pointer;
  settler: Settler;
}

export type Requirement = keyof RequirementDeps;

/** Every dependency a transport gives the registry. */
export interface ToolDeps extends RequirementDeps {
  clock: Clock;
}

/** The deps of a handler that requires `R`. */
export type DepsFor<R extends Requirement> = Pick<RequirementDeps, R> & { clock: Clock };
