import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readConfig, unreadableConfigMessage, type UnreadableConfig } from './config.js';

// Safety net: nothing in this file may bind the bridge or the IPC port of
// this machine (a live browser-link may own them). Any attempt fails here.
vi.mock('./bridge/ws-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge/ws-bridge.js')>();
  return {
    ...actual,
    startWsBridge: () => Promise.reject(new Error('test must not bind the bridge')),
  };
});
vi.mock('./bridge/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge/server.js')>();
  return {
    ...actual,
    IpcServer: class {
      constructor() {
        throw new Error('test must not start the IPC server');
      }
    },
  };
});
vi.mock('./bridge/proxy.js', () => ({
  runProxy: () => Promise.reject(new Error('test must not start a proxy')),
}));
import { BROWSER_TOOL_DEFINITIONS } from './tools/browser-definitions.js';
import { MAP_TOOL_DEFINITIONS } from './map/tools.js';
import {
  CONFIG_MISSING_NOW_MESSAGE,
  CONFIG_READABLE_AGAIN_MESSAGE,
  configRefusalFor,
  runServer,
  serveConfigRefusal,
} from './server.js';

/* S6.2: a server whose config.json is unreadable refuses every tool call
 * with the message, through the MCP protocol the agent reads, and starts
 * nothing else. Exercised over the SDK's in-memory transport: no stdio, no
 * port, no process. */

let dataDir: string;
let server: McpServer | null = null;
let client: Client | null = null;
const logs: string[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-server-refusal-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  logs.length = 0;
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = null;
  server = null;
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function writeConfig(contents: string): void {
  writeFileSync(join(dataDir, 'config.json'), contents, 'utf8');
}

function problem(): UnreadableConfig {
  const read = readConfig();
  if (read.state !== 'unreadable') throw new Error('config is not unreadable');
  return read;
}

async function connectedRefusal(p: UnreadableConfig): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  server = await serveConfigRefusal(p, serverSide, (line) => logs.push(line));
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('serveConfigRefusal: the MCP server while config.json is unreadable', () => {
  test('every tool call returns an error result whose text is the refusal message', async () => {
    writeConfig('{ "disabledTools": [');
    const c = await connectedRefusal(problem());
    for (const name of ['browser.list_tabs', 'browser.evaluate', 'map.read']) {
      const result = await c.callTool({ name, arguments: {} });
      expect(result).toEqual({
        content: [{ type: 'text', text: `Error: ${unreadableConfigMessage(problem())}` }],
        isError: true,
      });
    }
  });

  test('the server log names the file at start and on each refused call', async () => {
    writeConfig('[]');
    const c = await connectedRefusal(problem());
    expect(logs).toEqual([unreadableConfigMessage(problem())]);
    await c.callTool({ name: 'browser.navigate', arguments: { url: 'https://example.com' } });
    expect(logs.at(-1)).toBe(`Refused browser.navigate: ${unreadableConfigMessage(problem())}`);
  });

  test('the instructions the agent receives at connect are the refusal', async () => {
    writeConfig('nope');
    const c = await connectedRefusal(problem());
    expect(c.getInstructions()).toBe(unreadableConfigMessage(problem()));
  });

  test('tools/list offers every tool, so the agent can call one and read why it is refused', async () => {
    writeConfig('nope');
    const c = await connectedRefusal(problem());
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      [...BROWSER_TOOL_DEFINITIONS, ...MAP_TOOL_DEFINITIONS].map((t) => t.name),
    );
  });

  test('once the file is readable again, calls say to restart the MCP client', async () => {
    writeConfig('nope');
    const c = await connectedRefusal(problem());
    writeConfig('{}');
    const result = await c.callTool({ name: 'browser.list_tabs', arguments: {} });
    expect(result).toEqual({
      content: [{ type: 'text', text: `Error: ${CONFIG_READABLE_AGAIN_MESSAGE}` }],
      isError: true,
    });
  });

  test('once the file is gone, calls say it is missing now, not that it can be read', async () => {
    writeConfig('nope');
    const c = await connectedRefusal(problem());
    unlinkSync(join(dataDir, 'config.json'));
    const result = await c.callTool({ name: 'browser.list_tabs', arguments: {} });
    expect(result).toEqual({
      content: [{ type: 'text', text: `Error: ${CONFIG_MISSING_NOW_MESSAGE}` }],
      isError: true,
    });
    expect(CONFIG_MISSING_NOW_MESSAGE).not.toContain('can be read');
    expect(CONFIG_MISSING_NOW_MESSAGE).toContain('Restart your MCP client');
  });
});

describe('configRefusalFor: the guard in front of the primary tool dispatcher', () => {
  test('an unreadable config returns the refusal and logs it', () => {
    writeConfig('{');
    const log = vi.fn();
    expect(configRefusalFor('browser.click', log)).toEqual({
      content: [{ type: 'text', text: `Error: ${unreadableConfigMessage(problem())}` }],
      isError: true,
    });
    expect(log).toHaveBeenCalledWith(
      `Refused browser.click: ${unreadableConfigMessage(problem())}`,
    );
  });

  test.each([
    ['missing', null],
    ['valid', '{"disabledTools":["browser.evaluate"]}'],
    ['mistyped', '{"cdpDirectPort":"x"}'],
  ])('a %s config lets the call through (null), logging nothing', (_label, contents) => {
    if (contents !== null) writeConfig(contents);
    const log = vi.fn();
    expect(configRefusalFor('browser.click', log)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('runServer chooses the refusal before binding anything', () => {
  test('unreadable: serves the refusal and never starts the bridge', async () => {
    writeConfig('{');
    const refuse = vi.fn(async (_p: UnreadableConfig) => undefined);
    const start = vi.fn(async () => {
      throw new Error('must not start');
    });
    await runServer({ serveConfigRefusal: refuse, start });
    expect(refuse).toHaveBeenCalledWith(problem());
    expect(start).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', null, true],
    ['valid', '{"multiAgent":false}', false],
  ])('a %s config starts as before with the effective config', async (_l, contents, multi) => {
    if (contents !== null) writeConfig(contents);
    const refuse = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    await runServer({ serveConfigRefusal: refuse, start });
    expect(refuse).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toMatchObject({ multiAgent: multi });
  });
});
