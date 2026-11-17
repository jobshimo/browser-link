// The port contract suite (design 5.3, item 5) against the cdp-direct
// adapters on a real Chrome target. Runs only when CDP_CONTRACT_CHROME names
// a Chrome binary (the e2e CI job sets it); skipped otherwise, so `pnpm test`
// needs no browser. E2E_NO_SANDBOX=1 adds --no-sandbox (Linux CI).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  defineCdpSessionContract,
  defineKeyboardContract,
  definePageInfoContract,
  definePointerContract,
  type ContractCase,
} from '../../generated/core/ports/contract/index.js';
import { createPageDriver } from '../../generated/core/session/page-driver.js';
import type { MouseEventParams } from '../../generated/core/ports/values.js';

/** What Chrome answers for that wheel event. */
const PROBE_MESSAGE = "'deltaX' and 'deltaY' are expected for mouseWheel event";
/** What Chrome answers for an `Input.insertText` whose text is not a string. */
const INSERT_TEXT_REFUSED = 'Invalid parameters';
import { CdpClient } from '../client.js';
import { createCdpClientSession } from './cdp-client-session.js';
import { createCdpPageInfo } from './cdp-page-info.js';
import { systemClock } from './system-clock.js';

const CHROME = process.env.CDP_CONTRACT_CHROME;
const TITLE = 'cdp contract';
const PAGE = `data:text/html,<title>${encodeURIComponent(TITLE)}</title><p>contract</p>`;

let chrome: ChildProcess | undefined;
let profile: string | undefined;
let browserPort = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitForPort(dir: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    try {
      const [port] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n');
      if (Number(port) > 0) return Number(port);
    } catch {
      // not written yet
    }
    await sleep(50);
  }
  throw new Error('Chrome did not report its DevTools port');
}

/** A fresh page target on PAGE, loaded, with a connected client. */
async function openPage(): Promise<{ client: CdpClient; close: () => Promise<void> }> {
  const res = await fetch(`http://127.0.0.1:${String(browserPort)}/json/new?about:blank`, {
    method: 'PUT',
  });
  const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  const loaded = new Promise<void>((resolve) => {
    const off = client.on('Page.loadEventFired', () => {
      off();
      resolve();
    });
  });
  await client.send('Page.navigate', { url: PAGE });
  await loaded;
  return {
    client,
    close: async () => {
      client.close();
      await fetch(`http://127.0.0.1:${String(browserPort)}/json/close/${target.id}`);
    },
  };
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run(), 20_000);
}

describe.skipIf(!CHROME)('cdp-direct adapters on a real Chrome target', () => {
  beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), 'bl-cdp-contract-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(process.env.E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    chrome = spawn(CHROME ?? '', args, { stdio: 'ignore' });
    browserPort = await waitForPort(profile);
  }, 30_000);

  afterAll(async () => {
    chrome?.kill();
    await sleep(500);
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
  });

  describe('CdpSession contract: CdpClient adapter', () => {
    run(
      defineCdpSessionContract(async () => {
        const { client, close } = await openPage();
        const session = createCdpClientSession(client);
        const answered = { method: 'Runtime.evaluate', params: { expression: '"contract"' } };
        // What Chrome answers on the raw client is what the adapter must pass on.
        const result = await client.send(answered.method, answered.params);
        await client.send('Runtime.enable');
        return {
          session,
          answered: { ...answered, result },
          failing: {
            method: 'Contract.unknownMethod',
            message: "'Contract.unknownMethod' wasn't found",
          },
          trigger: async () => {
            await client.send('Runtime.evaluate', {
              expression: 'console.log("one"); console.log("two");',
            });
            return ['Runtime.consoleAPICalled', 'Runtime.consoleAPICalled'];
          },
          dispose: close,
        };
      }),
    );
  });

  describe("Pointer contract: the page driver's pointer over the CdpClient adapter", () => {
    run(
      definePointerContract(async () => {
        const { client, close } = await openPage();
        // Record the mouse events the page receives, as CDP event types.
        await client.send('Runtime.evaluate', {
          expression: `window.__seen = [];
            for (const [dom, cdp] of [['mousemove', 'mouseMoved'], ['mousedown', 'mousePressed'], ['mouseup', 'mouseReleased']])
              document.addEventListener(dom, () => window.__seen.push(cdp), true);`,
        });
        const driver = createPageDriver({
          session: createCdpClientSession(client),
          page: createCdpPageInfo(client, systemClock),
          clock: systemClock,
        });
        return {
          pointer: driver.pointer,
          at: { x: 20, y: 20 },
          received: async () => {
            const res = await client.send<{ result: { value: string[] } }>('Runtime.evaluate', {
              expression: 'window.__seen',
              returnByValue: true,
            });
            return res.result.value;
          },
          // A wheel event without its deltas: Chrome refuses it. The type is
          // outside `MouseEventParams` on purpose, so the cast is the probe.
          failing: {
            event: { type: 'mouseWheel', x: 20, y: 20 } as unknown as MouseEventParams,
            message: PROBE_MESSAGE,
          },
          dispose: close,
        };
      }),
    );
  });

  describe("Keyboard contract: the page driver's keyboard over the CdpClient adapter", () => {
    run(
      defineKeyboardContract(async () => {
        const { client, close } = await openPage();
        // An empty field with focus: `Input.insertText` types into it.
        await client.send('Runtime.evaluate', {
          expression: `const field = document.createElement('input');
            document.body.append(field);
            field.focus();`,
        });
        const driver = createPageDriver({
          session: createCdpClientSession(client),
          page: createCdpPageInfo(client, systemClock),
          clock: systemClock,
        });
        return {
          keyboard: driver.keyboard,
          focusedValue: async () => {
            const res = await client.send<{ result: { value: string } }>('Runtime.evaluate', {
              expression: 'document.activeElement.value',
              returnByValue: true,
            });
            return res.result.value;
          },
          // A text that is not a string: Chrome refuses its params. The
          // type is outside `insertText`'s on purpose, so the cast is the probe.
          failing: { text: 5 as unknown as string, message: INSERT_TEXT_REFUSED },
          dispose: close,
        };
      }),
    );
  });

  describe('PageInfo contract: CdpClient adapter', () => {
    run(
      definePageInfoContract(async () => {
        const { client, close } = await openPage();
        return {
          page: createCdpPageInfo(client, systemClock),
          expected: { url: PAGE, title: TITLE },
          completeLoad: async () => {
            const loaded = new Promise<void>((resolve) => {
              const off = client.on('Page.loadEventFired', () => {
                off();
                resolve();
              });
            });
            await client.send('Page.reload');
            await loaded;
          },
          elapse: sleep,
          dispose: close,
        };
      }),
    );
  });
});
