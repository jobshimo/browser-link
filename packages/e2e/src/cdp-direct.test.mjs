// cdp-direct.mjs: the CLI lines that enable cdp-direct and record the grant,
// how they run in the isolated environment, and how the cdp: tab is picked
// out of a list_tabs answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CDP_GRANT_MINUTES, cdpDirectCommands, cdpTabOf, enableCdpDirect } from './cdp-direct.mjs';

test('enables cdp-direct on the given port, then records a time-boxed grant', () => {
  assert.deepEqual(cdpDirectCommands(9333), [
    ['config', 'set', 'cdp-direct.enabled', 'true'],
    ['config', 'set', 'cdp-direct.port', '9333'],
    ['cdp', 'allow', '--minutes', String(CDP_GRANT_MINUTES)],
  ]);
  // A grant that expires, never `never` (0).
  assert.ok(CDP_GRANT_MINUTES > 0);
});

test('runs each command with the built CLI in the environment it is given', () => {
  const runs = [];
  const env = { BROWSER_LINK_DATA_DIR: '/tmp/data', HOME: '/tmp/home' };
  const out = enableCdpDirect({
    serverCli: '/build/cli.js',
    env,
    port: 4321,
    run: (cmd, args, opts) => {
      runs.push({ cmd, args, env: opts.env });
      return `ok ${args.join(' ')}\n`;
    },
  });
  assert.deepEqual(
    runs.map((r) => r.cmd),
    [process.execPath, process.execPath, process.execPath],
  );
  assert.deepEqual(
    runs.map((r) => r.args),
    cdpDirectCommands(4321).map((a) => ['/build/cli.js', ...a]),
  );
  for (const r of runs) assert.equal(r.env, env);
  assert.equal(out.length, 3);
  assert.equal(out[2], `ok /build/cli.js cdp allow --minutes ${String(CDP_GRANT_MINUTES)}\n`);
});

test('a failing command throws naming it, with its stderr, and stops there', () => {
  let calls = 0;
  assert.throws(
    () =>
      enableCdpDirect({
        serverCli: 'cli.js',
        env: {},
        port: 4321,
        run: (_cmd, args) => {
          calls++;
          if (args[1] === 'config' && args[3] === 'cdp-direct.port') {
            const e = new Error('Command failed');
            e.stderr = 'Invalid cdp-direct.port value\n';
            throw e;
          }
          return '';
        },
      }),
    {
      message:
        'browser-link config set cdp-direct.port 4321 failed: Command failed\nInvalid cdp-direct.port value',
    },
  );
  assert.equal(calls, 2);
});

test('cdpTabOf picks the first cdp: tab, optionally on a url', () => {
  const tabs = [
    { tab_id: '7', url: 'http://a/' },
    { tab_id: 'cdp:AA', transport: 'cdp', url: 'about:blank' },
    { tab_id: 'cdp:BB', transport: 'cdp', url: 'http://a/' },
  ];
  assert.equal(cdpTabOf(tabs)?.tab_id, 'cdp:AA');
  assert.equal(cdpTabOf(tabs, 'http://a/')?.tab_id, 'cdp:BB');
  assert.equal(cdpTabOf(tabs, 'http://b/'), undefined);
});

test('cdpTabOf needs both the cdp: id and transport "cdp"', () => {
  assert.equal(cdpTabOf([{ tab_id: 'cdp:AA' }]), undefined);
  assert.equal(cdpTabOf([{ tab_id: '12', transport: 'cdp' }]), undefined);
  assert.equal(cdpTabOf([null, { tab_id: 5, transport: 'cdp' }]), undefined);
});

test('cdpTabOf on an answer that is not a list is undefined', () => {
  assert.equal(cdpTabOf(null), undefined);
  assert.equal(cdpTabOf({ tab_id: 'cdp:AA', transport: 'cdp' }), undefined);
});
