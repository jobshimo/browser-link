// The port contract suite (design 5.3, item 5) against the cdp-direct
// adapters on a real Chrome target. Runs only when CDP_CONTRACT_CHROME names
// a Chrome binary (the e2e CI job sets it); skipped otherwise, so `pnpm test`
// needs no browser. E2E_NO_SANDBOX=1 adds --no-sandbox (Linux CI).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  countingSession,
  defineCdpEventsContract,
  defineCdpSessionContract,
  defineDragInputContract,
  defineKeyboardContract,
  defineNavigatorContract,
  definePageInfoContract,
  definePointerContract,
  defineResponseBodiesContract,
  defineScreenCaptureContract,
  type ContractCase,
} from '../../generated/core/ports/contract/index.js';
import { createPageDriver } from '../../generated/core/session/page-driver.js';
import type {
  CaptureParams,
  DragEventParams,
  MouseEventParams,
} from '../../generated/core/ports/values.js';

/** What Chrome answers for that wheel event. */
const PROBE_MESSAGE = "'deltaX' and 'deltaY' are expected for mouseWheel event";
/** What Chrome answers for an `Input.insertText` whose text is not a string. */
const INSERT_TEXT_REFUSED = 'Invalid parameters';
/** What Chrome answers for drag input whose params have the wrong type. */
const DRAG_PARAMS_REFUSED = 'Invalid parameters';
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

/** What Chrome answers for a navigation to a string that is not a URL. */
const INVALID_URL = 'Cannot navigate to invalid URL';
/** What Chrome answers for a screenshot format it does not know. */
const CAPTURE_REFUSED = 'Invalid image format';
/** What Chrome answers for a response body it does not hold. */
const NO_RESOURCE = 'No resource with given identifier found';
/** The document the response-bodies contract loads over HTTP. */
const SERVED = '<title>served</title><p>body</p>';

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

/** A page driver over the CdpClient adapter. */
function driverOn(client: CdpClient) {
  return createPageDriver({
    session: createCdpClientSession(client),
    page: createCdpPageInfo(client, systemClock),
    clock: systemClock,
  });
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

  describe("DragInput contract: the page driver's drag input over the CdpClient adapter", () => {
    run(
      defineDragInputContract(async () => {
        const { client, close } = await openPage();
        const driver = createPageDriver({
          session: createCdpClientSession(client),
          page: createCdpPageInfo(client, systemClock),
          clock: systemClock,
        });
        return {
          drag: driver.drag,
          // Params of the wrong type: Chrome refuses them. The types are
          // outside the port's on purpose, so the casts are the probes.
          failing: {
            event: { type: 'drop', x: 'far', y: 20, data: {} } as unknown as DragEventParams,
            message: DRAG_PARAMS_REFUSED,
          },
          failingIntercept: { enabled: 'yes' as unknown as boolean, message: DRAG_PARAMS_REFUSED },
          dispose: close,
        };
      }),
    );
  });

  describe("CdpEvents contract: the page driver's event wait over the CdpClient adapter", () => {
    run(
      defineCdpEventsContract(async () => {
        const { client, close } = await openPage();
        await client.send('Runtime.enable');
        const session = countingSession(createCdpClientSession(client));
        const driver = createPageDriver({
          session,
          page: createCdpPageInfo(client, systemClock),
          clock: systemClock,
        });
        return {
          events: driver.events,
          listening: () => session.listening(),
          method: 'Runtime.consoleAPICalled',
          emit: async () => {
            await client.send('Runtime.evaluate', { expression: 'console.log("contract")' });
          },
          elapse: sleep,
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
  describe("Navigator contract: the page driver's navigator over the CdpClient adapter", () => {
    run(
      defineNavigatorContract(async () => {
        const { client, close } = await openPage();
        return {
          navigator: driverOn(client).navigator,
          url: PAGE,
          failing: { url: 'not a url', message: INVALID_URL },
          dispose: close,
        };
      }),
    );
  });

  describe("ScreenCapture contract: the page driver's screen capture over the CdpClient adapter", () => {
    run(
      defineScreenCaptureContract(async () => {
        const { client, close } = await openPage();
        return {
          screen: driverOn(client).screen,
          // A format Chrome does not know: it refuses the params. The type
          // is outside the port's on purpose, so the cast is the probe.
          failing: {
            params: {
              format: 'gif',
              captureBeyondViewport: false,
              clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 },
            } as unknown as CaptureParams,
            message: CAPTURE_REFUSED,
          },
          dispose: close,
        };
      }),
    );
  });

  describe("ResponseBodies contract: the page driver's response bodies over the CdpClient adapter", () => {
    let server: Server | undefined;
    let url = '';
    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
        res.end(SERVED);
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/served`;
    });
    afterAll(async () => {
      // close() waits for open keep-alive connections, and Chrome keeps its own open.
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve();
        });
        server?.closeAllConnections();
      });
    });

    run(
      defineResponseBodiesContract(async () => {
        const { client, close } = await openPage();
        await client.send('Network.enable');
        let requestId = '';
        const finished = new Promise<void>((resolve) => {
          const offResponse = client.on('Network.responseReceived', (params) => {
            const p = params as { requestId: string; response: { url: string } };
            if (p.response.url === url) requestId = p.requestId;
          });
          const offFinished = client.on('Network.loadingFinished', (params) => {
            if ((params as { requestId: string }).requestId !== requestId) return;
            offResponse();
            offFinished();
            resolve();
          });
        });
        await client.send('Page.navigate', { url });
        await finished;
        return {
          responses: driverOn(client).responses,
          captured: { requestId, body: { body: SERVED, base64Encoded: false } },
          failing: { requestId: 'contract-unknown', message: NO_RESOURCE },
          dispose: close,
        };
      }),
    );
  });
});
