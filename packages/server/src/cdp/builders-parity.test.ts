import { describe, expect, test } from 'vitest';
import * as srv from './inpage/builders.js';
// Cross-package import of the extension ORIGINAL (pure string builders, no
// chrome.* at module load). If this ever fails to resolve, delete this file
// — `cdp/drift.test.ts` already guards the security-critical DEEP_QUERY_JS /
// DOM_HELPERS_JS bodies byte-for-byte, and each copy's header discloses the
// wrapper glue is not byte-compared. This test upgrades that to a full
// OUTPUT-identity check for the shared builders the subset copy carries.
import * as ext from '../../../extension/src/inpage/builders.js';

describe('cdp builders emit byte-identical output to the extension original', () => {
  test('buildSnapshotJs', () => {
    const opts = {
      within_selector: '#panel',
      only_interactive: true,
      exclude: ['nav'],
      max_interactive: 40,
    };
    expect(srv.buildSnapshotJs(opts)).toBe(ext.buildSnapshotJs(opts));
  });

  test('buildFindJs', () => {
    const opts = { text: 'Save changes', role: 'button', exact: true };
    expect(srv.buildFindJs(opts)).toBe(ext.buildFindJs(opts));
  });

  test('buildClickResolveJs', () => {
    const opts = { selector: '#btn', force: false };
    expect(srv.buildClickResolveJs(opts)).toBe(ext.buildClickResolveJs(opts));
  });

  test('buildTypeResolveJs (clear true and false)', () => {
    expect(srv.buildTypeResolveJs({ selector: '#in', clear: true })).toBe(
      ext.buildTypeResolveJs({ selector: '#in', clear: true }),
    );
    expect(srv.buildTypeResolveJs({ selector: '#in', clear: false })).toBe(
      ext.buildTypeResolveJs({ selector: '#in', clear: false }),
    );
  });

  test('buildFocusJs', () => {
    expect(srv.buildFocusJs({ selector: '#in' })).toBe(ext.buildFocusJs({ selector: '#in' }));
  });

  test('buildSettleJs', () => {
    const opts = { settle_ms: 150, settle_timeout_ms: 2000 };
    expect(srv.buildSettleJs(opts)).toBe(ext.buildSettleJs(opts));
  });

  test('buildStateJs', () => {
    expect(srv.buildStateJs()).toBe(ext.buildStateJs());
  });
});
