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
    const offset = { interactive: 120, headings: 30, text: 4000 };
    expect(srv.buildSnapshotJs({ offset })).toBe(ext.buildSnapshotJs({ offset }));
  });

  test('the cut hints of snapshot and find (owner decision D6)', () => {
    expect(srv.SNAPSHOT_CUT_HINT).toBe(ext.SNAPSHOT_CUT_HINT);
    expect(srv.SNAPSHOT_NOT_COMPARED_HINT).toBe(ext.SNAPSHOT_NOT_COMPARED_HINT);
    expect(srv.FIND_CUT_HINT).toBe(ext.FIND_CUT_HINT);
  });

  test('buildFindJs', () => {
    const opts = { text: 'Save changes', role: 'button', exact: true };
    expect(srv.buildFindJs(opts)).toBe(ext.buildFindJs(opts));
    expect(srv.buildFindJs({ ref: 'k3x9ab:e7' })).toBe(ext.buildFindJs({ ref: 'k3x9ab:e7' }));
    const key = { role: 'button', name: 'Save', path: [{ tag: 'body', index: 1 }] };
    expect(srv.buildFindJs({ key })).toBe(ext.buildFindJs({ key }));
    const bare = { key: { role: 'link', name: 'Docs' } };
    expect(srv.buildFindJs(bare)).toBe(ext.buildFindJs(bare));
    const paged = { text: 'Save', offset: { candidates: 5 } };
    expect(srv.buildFindJs(paged)).toBe(ext.buildFindJs(paged));
  });

  test('snapshot and find with the hide-password-values setting (owner decision D12)', () => {
    expect(srv.PASSWORD_VALUES_HIDDEN_NOTE).toBe(ext.PASSWORD_VALUES_HIDDEN_NOTE);
    expect(srv.SENSITIVE_FIELD_JS).toBe(ext.SENSITIVE_FIELD_JS);
    const hide = { hide_password_values: true } as const;
    expect(srv.buildSnapshotJs(hide)).toBe(ext.buildSnapshotJs(hide));
    expect(srv.buildSnapshotJs({ since: 'abc123:s1', ...hide })).toBe(
      ext.buildSnapshotJs({ since: 'abc123:s1', ...hide }),
    );
    for (const opts of [
      { text: 'Save', role: 'textbox', ...hide },
      { ref: 'k3x9ab:e7', ...hide },
      { key: { role: 'link', name: 'Docs' }, ...hide },
    ]) {
      expect(srv.buildFindJs(opts)).toBe(ext.buildFindJs(opts));
    }
    expect(srv.withValuesHiddenNote({ ok: true }, true)).toEqual(
      ext.withValuesHiddenNote({ ok: true }, true),
    );
  });

  test('buildClickResolveJs', () => {
    const opts = { selector: '#btn', force: false };
    expect(srv.buildClickResolveJs(opts)).toBe(ext.buildClickResolveJs(opts));
    const byRef = { ref: 'k3x9ab:e7', force: true };
    expect(srv.buildClickResolveJs(byRef)).toBe(ext.buildClickResolveJs(byRef));
  });

  test('FOCUS_REFUSAL_JS (type and press act only on an element that took focus)', () => {
    expect(srv.FOCUS_REFUSAL_JS).toBe(ext.FOCUS_REFUSAL_JS);
  });

  test('buildProgrammaticClickJs (owner decision D4)', () => {
    expect(srv.buildProgrammaticClickJs({ selector: '#btn' })).toBe(
      ext.buildProgrammaticClickJs({ selector: '#btn' }),
    );
    expect(srv.buildProgrammaticClickJs({ ref: 'k3x9ab:e7' })).toBe(
      ext.buildProgrammaticClickJs({ ref: 'k3x9ab:e7' }),
    );
  });

  test('buildTypeResolveJs (clear true and false)', () => {
    expect(srv.buildTypeResolveJs({ selector: '#in', clear: true })).toBe(
      ext.buildTypeResolveJs({ selector: '#in', clear: true }),
    );
    expect(srv.buildTypeResolveJs({ selector: '#in', clear: false })).toBe(
      ext.buildTypeResolveJs({ selector: '#in', clear: false }),
    );
    expect(srv.buildTypeResolveJs({ ref: 'k3x9ab:e7', clear: true })).toBe(
      ext.buildTypeResolveJs({ ref: 'k3x9ab:e7', clear: true }),
    );
  });

  test('buildFocusJs', () => {
    expect(srv.buildFocusJs({ selector: '#in' })).toBe(ext.buildFocusJs({ selector: '#in' }));
    expect(srv.buildFocusJs({ ref: 'k3x9ab:e7' })).toBe(ext.buildFocusJs({ ref: 'k3x9ab:e7' }));
  });

  test('buildFocusedFieldJs and the deep active-element walk it shares with buildStateJs', () => {
    expect(srv.DEEP_ACTIVE_ELEMENT_JS).toBe(ext.DEEP_ACTIVE_ELEMENT_JS);
    expect(srv.buildFocusedFieldJs()).toBe(ext.buildFocusedFieldJs());
    expect(srv.SENSITIVE_AUTOCOMPLETE_TOKENS).toEqual(ext.SENSITIVE_AUTOCOMPLETE_TOKENS);
  });

  test('isFocusedField reads an evaluation answer the same way on both transports', () => {
    for (const value of [
      { sensitive_field: true },
      { sensitive_field: false },
      { sensitive_field: 'yes' },
      true,
      null,
      undefined,
      {},
    ]) {
      expect(srv.isFocusedField(value)).toBe(ext.isFocusedField(value));
    }
  });

  test('actionFailure carries the flag the same way on both transports', () => {
    for (const field of [{ sensitive_field: true }, { sensitive_field: false }, true, undefined]) {
      expect(srv.actionFailure('boom', field)).toEqual(ext.actionFailure('boom', field));
    }
    expect(srv.actionFailure('boom', { sensitive_field: true })).toEqual({
      ok: false,
      error: 'boom',
      sensitive_field: true,
    });
    expect(srv.actionFailure('boom', { sensitive_field: false })).toEqual({
      ok: false,
      error: 'boom',
    });
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
    expect(srv.buildElementRectJs({ ref: 'k3x9ab:e7' })).toBe(
      ext.buildElementRectJs({ ref: 'k3x9ab:e7' }),
    );
  });

  test('buildStateJs', () => {
    expect(srv.buildStateJs()).toBe(ext.buildStateJs());
  });

  test('buildWaitForSelectorJs (every condition)', () => {
    for (const condition of ['visible', 'hidden', 'attached', 'detached'] as const) {
      expect(srv.buildWaitForSelectorJs('#panel .row', condition)).toBe(
        ext.buildWaitForSelectorJs('#panel .row', condition),
      );
      expect(srv.buildWaitForSelectorJs({ ref: 'k3x9ab:e7' }, condition)).toBe(
        ext.buildWaitForSelectorJs({ ref: 'k3x9ab:e7' }, condition),
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
    expect(srvObserver.buildObserverRefResolveJs('k3x9ab:e1')).toBe(
      extObserver.buildObserverRefResolveJs('k3x9ab:e1'),
    );
    expect(srvObserver.buildObserverRefResolveJs('e"42')).toBe(
      extObserver.buildObserverRefResolveJs('e"42'),
    );
  });

  test('buildObserverSemanticKeyJs', () => {
    expect(srvObserver.buildObserverSemanticKeyJs('k3x9ab:e1')).toBe(
      extObserver.buildObserverSemanticKeyJs('k3x9ab:e1'),
    );
    expect(srvObserver.buildObserverSemanticKeyJs('e"42</script>')).toBe(
      extObserver.buildObserverSemanticKeyJs('e"42</script>'),
    );
  });
});
