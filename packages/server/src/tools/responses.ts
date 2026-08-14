/**
 * MCP tool-response helpers shared between the browser bridge and the map.
 * Lifted out of runServer() so they can be unit-tested in isolation.
 */

/** Shape we emit for an MCP tool result. Index signature is intentional:
 * newer @modelcontextprotocol/sdk schemas extend ServerResult with optional
 * fields we do not populate (e.g. task), and we want the structural type
 * to remain compatible without us having to track every SDK addition. */
export interface ToolResponse {
  content: { type: 'text'; text: string }[];
  isError?: true;
  [extra: string]: unknown;
}

export function toolResponse(data: unknown): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function toolError(message: string): ToolResponse {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function requireTabId(args: unknown): string {
  const id = (args as { tab_id?: string } | undefined)?.tab_id;
  if (!id) throw new Error('tab_id required');
  return id;
}
