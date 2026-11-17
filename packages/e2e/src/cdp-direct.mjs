// cdp-direct, the server's second transport, in the e2e run (run.mjs
// cdpDirectChecks): a second headless Chrome without the extension, listening
// on a free remote-debugging port, which the server reaches directly once the
// owner's two opt-ins hold. The harness gives them the way the owner does,
// with the built server's own CLI (`config set cdp-direct.enabled true`,
// `config set cdp-direct.port <port>`, `cdp allow --minutes N`), run inside
// the run's isolated environment (lib.mjs isolatedServerEnv), so the grant
// lands in the temp data dir and never in the owner's.
import { execFileSync } from 'node:child_process';

/** Lifetime of the run's grant: far longer than the run, and not `never`. */
export const CDP_GRANT_MINUTES = 10;

/** The CLI command lines (argv after the CLI path) that enable cdp-direct on
 * `port` and record a grant, in the order the README gives them. */
export function cdpDirectCommands(port) {
  return [
    ['config', 'set', 'cdp-direct.enabled', 'true'],
    ['config', 'set', 'cdp-direct.port', String(port)],
    ['cdp', 'allow', '--minutes', String(CDP_GRANT_MINUTES)],
  ];
}

/** Run each command of `cdpDirectCommands(port)` with the built CLI at
 * `serverCli` in `env` (`run` is execFileSync, replaceable in tests).
 * Returns each command's stdout; throws naming the command, with its stderr,
 * when one exits non-zero. */
export function enableCdpDirect({ serverCli, env, port, run = execFileSync }) {
  return cdpDirectCommands(port).map((args) => {
    try {
      return String(
        run(process.execPath, [serverCli, ...args], {
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch (e) {
      const stderr = String(e?.stderr ?? '').trim();
      throw new Error(
        `browser-link ${args.join(' ')} failed: ${String(e?.message ?? e)}${stderr ? `\n${stderr}` : ''}`,
      );
    }
  });
}

/** The first cdp-direct tab of a `browser.list_tabs` answer (`tab_id`
 * `cdp:<targetId>`, `transport: "cdp"`), optionally on `url`; undefined when
 * there is none or the answer is not a list. */
export function cdpTabOf(tabs, url) {
  if (!Array.isArray(tabs)) return undefined;
  return tabs.find(
    (t) =>
      t &&
      t.transport === 'cdp' &&
      typeof t.tab_id === 'string' &&
      t.tab_id.startsWith('cdp:') &&
      (url === undefined || t.url === url),
  );
}
