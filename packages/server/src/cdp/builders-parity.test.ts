import { describe, expect, test } from 'vitest';
import * as srv from './inpage/builders.js';
// Cross-package import of the extension ORIGINAL (pure string builders, no
// chrome.* at module load). If this ever fails to resolve, delete this file
// — `cdp/drift.test.ts` already guards the security-critical DEEP_QUERY_JS /
// DOM_HELPERS_JS bodies byte-for-byte, and each copy's header discloses the
// wrapper glue is not byte-compared. This test upgrades that to a full
// OUTPUT-identity check for the shared builders the subset copy carries.
import * as ext from '../../../extension/src/inpage/builders.js';
import * as srvObserver from './inpage/observer.js';
import * as extObserver from '../../../extension/src/inpage/observer.js';

describe('cdp builders emit byte-identical output to the extension original', () => {
  test('PAGE_OBSERVER_JS (the shared ref/doc_id helper)', () => {
    expect(srv.PAGE_OBSERVER_JS).toBe(ext.PAGE_OBSERVER_JS);
  });

  test('RESOLVE_TARGET_JS (the shared selector / ref target resolver)', () => {
    expect(srv.RESOLVE_TARGET_JS).toBe(ext.RESOLVE_TARGET_JS);
  });

  test('buildSnapshotJs', () => {
    const opts = {
      within_selector: '#panel',
      only_interactive: true,
      exclude: ['nav'],
      max_interactive: 40,
    };
    expect(srv.buildSnapshotJs(opts)).toBe(ext.buildSnapshotJs(opts));
    expect(srv.buildSnapshotJs({ since: 'abc123:s1' })).toBe(
      ext.buildSnapshotJs({ since: 'abc123:s1' }),
    );
  });

  test('buildFindJs', () => {
    const opts = { text: 'Save changes', role: 'button', exact: true };
    expect(srv.buildFindJs(opts)).toBe(ext.buildFindJs(opts));
    expect(srv.buildFindJs({ ref: 'e7' })).toBe(ext.buildFindJs({ ref: 'e7' }));
  });

  test('buildClickResolveJs', () => {
    const opts = { selector: '#btn', force: false };
    expect(srv.buildClickResolveJs(opts)).toBe(ext.buildClickResolveJs(opts));
    const byRef = { ref: 'e7', force: true };
    expect(srv.buildClickResolveJs(byRef)).toBe(ext.buildClickResolveJs(byRef));
  });

  test('buildTypeResolveJs (clear true and false)', () => {
    expect(srv.buildTypeResolveJs({ selector: '#in', clear: true })).toBe(
      ext.buildTypeResolveJs({ selector: '#in', clear: true }),
    );
    expect(srv.buildTypeResolveJs({ selector: '#in', clear: false })).toBe(
      ext.buildTypeResolveJs({ selector: '#in', clear: false }),
    );
    expect(srv.buildTypeResolveJs({ ref: 'e7', clear: true })).toBe(
      ext.buildTypeResolveJs({ ref: 'e7', clear: true }),
    );
  });

  test('buildFocusJs', () => {
    expect(srv.buildFocusJs({ selector: '#in' })).toBe(ext.buildFocusJs({ selector: '#in' }));
    expect(srv.buildFocusJs({ ref: 'e7' })).toBe(ext.buildFocusJs({ ref: 'e7' }));
  });

  test('buildSettleJs', () => {
    const opts = { settle_ms: 150, settle_timeout_ms: 2000 };
    expect(srv.buildSettleJs(opts)).toBe(ext.buildSettleJs(opts));
  });

  test('buildExpectProbeJs (every condition, and none)', () => {
    const opts = { selector_appears: '#a', selector_disappears: '.b', text_appears: 'Done' };
    expect(srv.buildExpectProbeJs(opts)).toBe(ext.buildExpectProbeJs(opts));
    expect(srv.buildExpectProbeJs({})).toBe(ext.buildExpectProbeJs({}));
  });

  test('buildElementRectJs', () => {
    expect(srv.buildElementRectJs({ selector: '#card' })).toBe(
      ext.buildElementRectJs({ selector: '#card' }),
    );
    expect(srv.buildElementRectJs({ ref: 'e7' })).toBe(ext.buildElementRectJs({ ref: 'e7' }));
  });

  test('buildStateJs', () => {
    expect(srv.buildStateJs()).toBe(ext.buildStateJs());
  });

  test('buildWaitForSelectorJs (every condition)', () => {
    for (const condition of ['visible', 'hidden', 'attached', 'detached'] as const) {
      expect(srv.buildWaitForSelectorJs('#panel .row', condition)).toBe(
        ext.buildWaitForSelectorJs('#panel .row', condition),
      );
      expect(srv.buildWaitForSelectorJs({ ref: 'e7' }, condition)).toBe(
        ext.buildWaitForSelectorJs({ ref: 'e7' }, condition),
      );
    }
  });
});

describe('cdp page observer emits byte-identical output to the extension original', () => {
  test('exported constants', () => {
    expect(srvObserver.OBSERVER_VERSION).toBe(extObserver.OBSERVER_VERSION);
    expect(srvObserver.OBSERVER_BINDING).toBe(extObserver.OBSERVER_BINDING);
    expect(srvObserver.OBSERVER_GLOBAL).toBe(extObserver.OBSERVER_GLOBAL);
  });

  test('buildObserverInstallJs (defaults and explicit options)', () => {
    expect(srvObserver.buildObserverInstallJs()).toBe(extObserver.buildObserverInstallJs());
    const opts = { binding: '__custom', version: 7, descriptor_cap: 5, ring_size: 8 };
    expect(srvObserver.buildObserverInstallJs(opts)).toBe(extObserver.buildObserverInstallJs(opts));
  });

  test('buildObserverMarkJs, buildObserverChangesJs and buildObserverTeardownJs', () => {
    expect(srvObserver.buildObserverMarkJs()).toBe(extObserver.buildObserverMarkJs());
    expect(srvObserver.buildObserverChangesJs(3)).toBe(extObserver.buildObserverChangesJs(3));
    expect(srvObserver.buildObserverChangesJs(3, 'doc-1')).toBe(
      extObserver.buildObserverChangesJs(3, 'doc-1'),
    );
    expect(srvObserver.buildObserverTeardownJs()).toBe(extObserver.buildObserverTeardownJs());
  });

  test('buildObserverRefResolveJs', () => {
    expect(srvObserver.buildObserverRefResolveJs('e1')).toBe(
      extObserver.buildObserverRefResolveJs('e1'),
    );
    expect(srvObserver.buildObserverRefResolveJs('e"42')).toBe(
      extObserver.buildObserverRefResolveJs('e"42'),
    );
  });

  test('buildObserverSemanticKeyJs', () => {
    expect(srvObserver.buildObserverSemanticKeyJs('e1')).toBe(
      extObserver.buildObserverSemanticKeyJs('e1'),
    );
    expect(srvObserver.buildObserverSemanticKeyJs('e"42</script>')).toBe(
      extObserver.buildObserverSemanticKeyJs('e"42</script>'),
    );
  });
});
