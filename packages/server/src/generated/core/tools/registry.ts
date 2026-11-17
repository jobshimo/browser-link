// GENERATED from packages/core/src/tools/registry.ts. Do not edit.
/**
 * The tool registry (design 3.3): each entry names a wire tool, what it
 * requires from the transport, its argument coercion and its handler.
 * `dispatchTool` is what both transports call for a registered tool, in
 * place of their own `case` (the extension's `handleTool`, cdp-direct's
 * `callCdpTool`); slices 10-18 move the tools in one family at a time.
 */
import { thrownFailure, type ToolOutcome } from './failure.js';
import type { DepsFor, Requirement, ToolDeps } from './requirement.js';

/** The two transports. Argument coercion differs between them today
 * (design 7(e)): each entry keeps one `coerce` per transport until a
 * behavior PR unifies them. */
export type Transport = 'extension' | 'cdp-direct';

export interface ToolEntry<P = unknown, R extends Requirement = Requirement> {
  /** The wire name: 'click', not 'browser.click'. */
  name: string;
  requires: readonly R[];
  /** false for internal wire tools (download_settle). */
  listed: boolean;
  /** Today's argument coercion of each transport, from the raw params. */
  coerce: Readonly<Record<Transport, (params: Record<string, unknown>) => P>>;
  handler(deps: DepsFor<R>, params: P): Promise<ToolOutcome>;
}

/** An entry as the registry holds it, its params type erased: any
 * `ToolEntry<P, R>` is one, and `dispatchTool` hands the handler the params
 * its own `coerce` produced. */
export interface RegisteredTool {
  name: string;
  requires: readonly Requirement[];
  listed: boolean;
  coerce: Readonly<Record<Transport, (params: Record<string, unknown>) => unknown>>;
  handler(deps: ToolDeps, params: never): Promise<ToolOutcome>;
}

export type ToolRegistry = ReadonlyMap<string, RegisteredTool>;

/** Build a registry; a name registered twice is a programming error. */
export function createToolRegistry(entries: readonly RegisteredTool[]): ToolRegistry {
  const registry = new Map<string, RegisteredTool>();
  for (const entry of entries) {
    if (registry.has(entry.name)) throw new Error(`tool registered twice: ${entry.name}`);
    registry.set(entry.name, entry);
  }
  return registry;
}

/**
 * Run `tool` through its entry: `unknown-tool` when it is not registered,
 * `unsupported` when the transport does not provide a requirement, `thrown`
 * when the coercion or the handler throws; otherwise the handler's outcome.
 */
export async function dispatchTool(
  registry: ToolRegistry,
  provided: ReadonlySet<Requirement>,
  deps: ToolDeps,
  transport: Transport,
  tool: string,
  params: unknown,
): Promise<ToolOutcome> {
  const entry = registry.get(tool);
  if (!entry) return { ok: false, failure: { kind: 'unknown-tool', tool } };
  const missing = entry.requires.filter((requirement) => !provided.has(requirement));
  if (missing.length > 0) return { ok: false, failure: { kind: 'unsupported', tool, missing } };
  try {
    const coerced = entry.coerce[transport]((params ?? {}) as Record<string, unknown>);
    return await entry.handler(deps, coerced as never);
  } catch (err) {
    return thrownFailure(err);
  }
}
