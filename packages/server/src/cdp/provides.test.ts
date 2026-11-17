// What cdp-direct provides to the tool registry (design 3.3). The set is v1
// scope: it never enables the Network domain, so it has no capture buffers
// and a `network_url` wait is refused. Declaring a capability it lacks is a
// behavior change (7(e)), so this test pins the set.
import { describe, expect, test } from 'vitest';
import { TOOL_REGISTRY } from '../generated/core/tools/catalog.js';
import { dispatchTool } from '../generated/core/tools/registry.js';
import type { ToolDeps } from '../generated/core/tools/requirement.js';
import { systemClock } from './adapters/system-clock.js';
import { CDP_DIRECT_PROVIDES } from './transport.js';

describe('CDP_DIRECT_PROVIDES', () => {
  test('is the four page ports, without capture-buffers', () => {
    expect([...CDP_DIRECT_PROVIDES].sort()).toEqual([
      'evaluator',
      'keyboard',
      'pointer',
      'settler',
    ]);
  });

  test('a network_url wait on cdp-direct is refused with the extension fallback text', async () => {
    const deps = { clock: systemClock } as unknown as ToolDeps;
    const outcome = await dispatchTool(
      TOOL_REGISTRY,
      CDP_DIRECT_PROVIDES,
      deps,
      'cdp-direct',
      'wait_for',
      {
        network_url: '/api',
      },
    );
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: 'action',
        message:
          'wait_for: network_url mode is not supported over cdp-direct in v1 (no network buffering) — use a tab connected through the Chrome extension instead.',
      },
    });
  });
});
