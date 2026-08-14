import { describe, expect, test } from 'vitest';
import {
  buildClickResolveJs,
  buildFindJs,
  buildFocusJs,
  buildSettleJs,
  buildSnapshotJs,
  buildStateJs,
  buildTypeResolveJs,
} from './builders.js';
import { DEEP_QUERY_JS } from './deep-query.js';
import { DOM_HELPERS_JS } from './dom-helpers.js';

/*
 * Local coverage of the server's verbatim in-page builder copies. These
 * produce the exact JS SOURCE STRING sent over CDP `Runtime.evaluate`; the
 * extension's own `inpage/builders.test.ts` executes the identical strings
 * under jsdom, and `cdp/drift.test.ts` proves the shared DEEP_QUERY_JS /
 * DOM_HELPERS_JS bodies are byte-identical, so asserting the server builders
 * (a) interpolate those exact shared helpers and (b) embed the caller's opts
 * is enough to prove the server copy assembles the same shipped expression
 * without duplicating jsdom (not a dependency of this package).
 */

describe('builder output embeds the shared deep-query/dom-helpers logic', () => {
  test('buildSnapshotJs interpolates both shared helpers and the opts', () => {
    const src = buildSnapshotJs({ within_selector: '#panel', only_interactive: true });
    expect(src).toContain(DEEP_QUERY_JS);
    expect(src).toContain(DOM_HELPERS_JS);
    expect(src).toContain('#panel');
    expect(src).toContain('"onlyInteractive":true');
  });

  test('buildFindJs interpolates the shared helpers and the query text', () => {
    const src = buildFindJs({ text: 'Save changes', role: 'button' });
    expect(src).toContain(DEEP_QUERY_JS);
    expect(src).toContain(DOM_HELPERS_JS);
    expect(src).toContain('Save changes');
    expect(src).toContain('"role":"button"');
  });

  test('buildStateJs interpolates both shared helpers', () => {
    const src = buildStateJs();
    expect(src).toContain(DEEP_QUERY_JS);
    expect(src).toContain(DOM_HELPERS_JS);
    expect(src).toContain('deepActiveElement');
  });

  test('buildClickResolveJs embeds selector + force and the invalid-selector pre-check', () => {
    const src = buildClickResolveJs({ selector: '#btn', force: true });
    expect(src).toContain(DEEP_QUERY_JS);
    expect(src).toContain('"selector":"#btn"');
    expect(src).toContain('"force":true');
    expect(src).toContain('invalid-selector');
  });

  test('buildTypeResolveJs embeds a clear branch only when clear:true', () => {
    expect(buildTypeResolveJs({ selector: '#in', clear: true })).toContain("el.value = ''");
    expect(buildTypeResolveJs({ selector: '#in', clear: false })).not.toContain("el.value = ''");
  });

  test('buildFocusJs resolves + focuses the selector', () => {
    const src = buildFocusJs({ selector: '#in' });
    expect(src).toContain('"selector":"#in"');
    expect(src).toContain('el.focus()');
  });
});

describe('buildSettleJs clamps its inputs', () => {
  test('negative settle values are clamped to 0 in the emitted opts', () => {
    const src = buildSettleJs({ settle_ms: -5, settle_timeout_ms: -10 });
    expect(src).toContain('"settleMs":0');
    expect(src).toContain('"timeoutMs":0');
  });

  test('passes through in-range values', () => {
    const src = buildSettleJs({ settle_ms: 150, settle_timeout_ms: 2000 });
    expect(src).toContain('"settleMs":150');
    expect(src).toContain('"timeoutMs":2000');
  });
});
