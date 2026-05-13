/**
 * Structured human-facing documentation co-located with each tool definition.
 *
 * Rendered into the MCP SERVER_INSTRUCTIONS string by
 * `tools/server-instructions.ts`. The structured shape lets us keep the
 * "what / when / gotchas / example" close to the tool itself instead of
 * drifting in a big monolithic string, and lets tests assert per-tool
 * completeness (purpose + when_to_use are mandatory).
 */
export interface ToolDoc {
  /** What the tool is for, one sentence. */
  purpose: string;
  /** When the agent should reach for it — triggers in plain language. */
  when_to_use: string[];
  /** Non-obvious gotchas / contracts to honour. Optional. */
  gotchas?: string[];
  /** A short representative invocation snippet. Optional. */
  example?: string;
}

/** Shape of an MCP tool definition for our ListToolsRequestSchema response.
 *
 * The optional `doc` field carries the structured documentation consumed by
 * `buildServerInstructions()`. Tools that omit it are not surfaced in the
 * generated instructions; tools that include it must provide non-empty
 * `purpose` and `when_to_use` (asserted by tests). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  doc?: ToolDoc;
}
