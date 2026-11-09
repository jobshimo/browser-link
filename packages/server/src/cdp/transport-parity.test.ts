import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/*
 * PARITY GUARD for the hand-mirrored action handlers. `performFind`,
 * `performClick`, `performType`, `performPress` and `performWaitFor` exist
 * twice: in the extension's `background.ts` (driving a tab through
 * `chrome.debugger`) and in `cdp/transport.ts` (driving a cdp-direct target
 * through a raw CDP client). Extracting them into one shared module is a
 * 1.1 refactor; until then this test keeps the two copies from drifting.
 *
 * How it compares: each handler BODY (not its signature, whose first
 * parameter is necessarily transport-specific) is re-printed from the
 * TypeScript AST with comments removed, so formatting and comments never
 * count. The only rewrites applied are the transport seam:
 *   - the session parameter (`tabId` in the extension, `client` on the
 *     server) is renamed `session`;
 *   - the extension's `cdp(tabId, method, …)` becomes `session.send(method, …)`,
 *     the server client's call shape.
 * Anything else that differs fails, naming the handler and the first
 * differing line. A known semantic divergence is excluded only through an
 * entry in `ALLOWED_DIVERGENCES` below, which names it and says why; each
 * entry must still match the current source, so a stale entry fails too.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EXT_BACKGROUND = join(here, '..', '..', '..', 'extension', 'src', 'background.ts');
const SRV_TRANSPORT = join(here, 'transport.ts');

const HANDLERS = [
  'performFind',
  'performClick',
  'performType',
  'performPress',
  'performWaitFor',
] as const;
type Handler = (typeof HANDLERS)[number];

/** A statement block present on one side only. `start` is the exact
 * printed text that opens it; when it ends with `{` the fragment runs to
 * the matching closing brace, otherwise it is that single statement. */
interface Fragment {
  start: string;
}

interface AllowedDivergence {
  handler: Handler;
  name: string;
  reason: string;
  extensionOnly: Fragment[];
  serverOnly: Fragment[];
}

const ALLOWED_DIVERGENCES: readonly AllowedDivergence[] = [
  {
    handler: 'performWaitFor',
    name: 'network-url-mode',
    reason:
      'cdp-direct never enables the Network domain, so the server rejects a ' +
      '`network_url` wait up front while the extension polls its network ' +
      'buffer (`state.networkOrder`). Open until the 1.1 shared CdpSession ' +
      'gives both transports one network buffer.',
    extensionOnly: [
      { start: 'const waitNetworkUrl = params.network_url;' },
      { start: 'else if (waitNetworkUrl !== undefined) {' },
    ],
    serverOnly: [{ start: 'if (params.network_url !== undefined) {' }],
  },
];

const printer = ts.createPrinter({ removeComments: true });

function printedBody(file: string, name: Handler): string {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let body: ts.Block | undefined;
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node.body;
  });
  if (!body) throw new Error(`could not find function ${name} in ${file}`);
  return printer.printNode(ts.EmitHint.Unspecified, body, sf);
}

const SESSION_PARAM = { tabId: /\btabId\b/g, client: /\bclient\b/g } as const;

function applySeam(body: string, sessionParam: keyof typeof SESSION_PARAM): string {
  return body
    .replace(SESSION_PARAM[sessionParam], 'session')
    .replace(/\bcdp\(session, /g, 'session.send(');
}

function removeFragment(body: string, fragment: Fragment, where: string): string {
  const at = body.indexOf(fragment.start);
  if (at < 0) {
    throw new Error(`stale allowlist entry (${where}): "${fragment.start}" no longer present`);
  }
  if (!fragment.start.endsWith('{')) {
    return body.slice(0, at) + body.slice(at + fragment.start.length);
  }
  let depth = 0;
  let i = at + fragment.start.length - 1;
  for (; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return body.slice(0, at) + body.slice(i + 1);
}

function lines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function normalised(handler: Handler): { extension: string[]; server: string[] } {
  let extension = applySeam(printedBody(EXT_BACKGROUND, handler), 'tabId');
  let server = applySeam(printedBody(SRV_TRANSPORT, handler), 'client');
  for (const entry of ALLOWED_DIVERGENCES.filter((e) => e.handler === handler)) {
    for (const f of entry.extensionOnly) extension = removeFragment(extension, f, entry.name);
    for (const f of entry.serverOnly) server = removeFragment(server, f, entry.name);
  }
  return { extension: lines(extension), server: lines(server) };
}

function firstDifference(a: string[], b: string[]): string | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}:\n  extension: ${a[i] ?? '<end>'}\n  server:    ${b[i] ?? '<end>'}`;
    }
  }
  return null;
}

describe('perform* parity guard: extension background.ts vs server cdp/transport.ts', () => {
  for (const handler of HANDLERS) {
    test(`${handler} has the same body on both transports`, () => {
      const { extension, server } = normalised(handler);
      const diff = firstDifference(extension, server);
      expect(diff, `${handler} diverges at ${diff ?? ''}`).toBeNull();
    });
  }

  test('every allowlist entry names a handler and gives a reason', () => {
    for (const entry of ALLOWED_DIVERGENCES) {
      expect(HANDLERS).toContain(entry.handler);
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.extensionOnly.length + entry.serverOnly.length).toBeGreaterThan(0);
    }
  });

  test('the comparison is not vacuous: a one-token change is reported', () => {
    const { server } = normalised('performClick');
    const mutated = server.map((l) => l.replace("'mousePressed'", "'mouseMoved'"));
    expect(firstDifference(server, mutated)).toMatch(/line \d+:/);
  });
});
