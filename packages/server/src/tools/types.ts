/** Shape of an MCP tool definition for our ListToolsRequestSchema response. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
