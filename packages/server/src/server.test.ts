import { afterEach, describe, expect, test, vi } from 'vitest';
import { VERSION } from './version.js';

// Capture what the MCP server is constructed with; nothing else of the SDK
// class is exercised here.
const constructed = vi.hoisted(() => [] as unknown[][]);
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    server = { setRequestHandler: () => undefined };
    constructor(...args: unknown[]) {
      constructed.push(args);
    }
  },
}));

const { createMcpServer } = await import('./server.js');

afterEach(() => {
  constructed.length = 0;
});

describe('createMcpServer', () => {
  test('announces the running VERSION as serverInfo, with the tools capability and instructions', () => {
    createMcpServer('the instructions');
    expect(constructed).toEqual([
      [
        { name: 'browser-link', version: VERSION },
        { capabilities: { tools: {} }, instructions: 'the instructions' },
      ],
    ]);
  });
});
