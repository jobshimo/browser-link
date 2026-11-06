/**
 * MCP tool-response helpers shared between the browser bridge and the map.
 * Lifted out of runServer() so they can be unit-tested in isolation.
 */

/** Shape we emit for an MCP tool result. Index signature is intentional:
 * newer @modelcontextprotocol/sdk schemas extend ServerResult with optional
 * fields we do not populate (e.g. task), and we want the structural type
 * to remain compatible without us having to track every SDK addition. */
export interface ToolResponse {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
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

/**
 * Response for a tool whose result carries a base64 image in `image_b64`
 * (`browser.screenshot`): the metadata goes out as a text block WITHOUT the
 * base64 (so it is not paid for twice) and the image as a real MCP image
 * content block. Anything without image data degrades to a plain
 * `toolResponse`.
 */
export function imageToolResponse(data: unknown): ToolResponse {
  if (typeof data !== 'object' || data === null) return toolResponse(data);
  const { image_b64: image, ...meta } = data as Record<string, unknown>;
  if (typeof image !== 'string' || image.length === 0) return toolResponse(data);
  const mimeType = meta.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return {
    content: [
      { type: 'text', text: JSON.stringify(meta, null, 2) },
      { type: 'image', data: image, mimeType },
    ],
  };
}

/**
 * Same payload as `toolResponse`, plus a SECOND text block `hint: <text>`.
 * The first block stays byte-for-byte what a plain response would be, so
 * clients that parse it (a bare JSON array for `browser.list_tabs`) are
 * unaffected; the hint is purely additive for readers of the extra block.
 */
export function hintToolResponse(data: unknown, hint: string): ToolResponse {
  const base = toolResponse(data);
  return { content: [...base.content, { type: 'text', text: `hint: ${hint}` }] };
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
