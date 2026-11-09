import { describe, expect, test } from 'vitest';
import {
  PRESETS,
  TOOL_CATALOGUE,
  getPreset,
  isKnownTool,
  isToolEnabled,
  sanitizeDisabledTools,
} from './permissions.js';

describe('TOOL_CATALOGUE', () => {
  test('has no duplicate names', () => {
    const names = TOOL_CATALOGUE.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every tool has a non-empty summary and a known family + category', () => {
    for (const t of TOOL_CATALOGUE) {
      expect(t.summary.length).toBeGreaterThan(0);
      expect(['bridge', 'map']).toContain(t.family);
      expect(['read', 'action', 'eval', 'map-read', 'map-write', 'write']).toContain(t.category);
    }
  });

  test('covers exactly the 40 tools currently exposed', () => {
    // If this fails, somebody added a tool elsewhere and forgot to register
    // it here — the permissions UI / CLI / server filter will silently miss it.
    expect(TOOL_CATALOGUE.length).toBe(40);
  });

  test('browser.activity is a read tool of the bridge family, so it can be disabled and the readonly preset keeps it', () => {
    const activity = TOOL_CATALOGUE.find((t) => t.name === 'browser.activity');
    expect(activity?.family).toBe('bridge');
    expect(activity?.category).toBe('read');
    expect(isKnownTool('browser.activity')).toBe(true);
    expect(sanitizeDisabledTools(['browser.activity'])).toEqual(['browser.activity']);
    expect(getPreset('readonly').disabled).not.toContain('browser.activity');
  });

  test('browser.manual is a read tool of the bridge family', () => {
    const manual = TOOL_CATALOGUE.find((t) => t.name === 'browser.manual');
    expect(manual?.family).toBe('bridge');
    expect(manual?.category).toBe('read');
  });

  test('browser.download is an action (it clicks and writes a file to disk)', () => {
    const download = TOOL_CATALOGUE.find((t) => t.name === 'browser.download');
    expect(download?.family).toBe('bridge');
    expect(download?.category).toBe('action');
  });

  test('includes browser.flow_status as a read tool and browser.flow_cancel as an action', () => {
    // The two halves of the flow lifecycle sit in different categories on
    // purpose, and the split has teeth: the `readonly` preset must leave
    // an operator able to SEE what a detached flow is doing while denying
    // the ability to start or stop one.
    const status = TOOL_CATALOGUE.find((t) => t.name === 'browser.flow_status');
    expect(status).toBeDefined();
    expect(status?.family).toBe('bridge');
    expect(status?.category).toBe('read');

    const cancel = TOOL_CATALOGUE.find((t) => t.name === 'browser.flow_cancel');
    expect(cancel).toBeDefined();
    expect(cancel?.family).toBe('bridge');
    expect(cancel?.category).toBe('action');

    const readonly = getPreset('readonly').disabled;
    expect(readonly).not.toContain('browser.flow_status');
    expect(readonly).toContain('browser.flow_cancel');
  });

  test('includes browser.press as an action tool', () => {
    const press = TOOL_CATALOGUE.find((t) => t.name === 'browser.press');
    expect(press).toBeDefined();
    expect(press?.family).toBe('bridge');
    expect(press?.category).toBe('action');
  });

  test('includes browser.flow as an action tool', () => {
    const flow = TOOL_CATALOGUE.find((t) => t.name === 'browser.flow');
    expect(flow).toBeDefined();
    expect(flow?.family).toBe('bridge');
    expect(flow?.category).toBe('action');
  });

  test('includes browser.find as a read tool', () => {
    const find = TOOL_CATALOGUE.find((t) => t.name === 'browser.find');
    expect(find).toBeDefined();
    expect(find?.family).toBe('bridge');
    expect(find?.category).toBe('read');
  });

  test('includes browser.state as a read tool', () => {
    const state = TOOL_CATALOGUE.find((t) => t.name === 'browser.state');
    expect(state).toBeDefined();
    expect(state?.family).toBe('bridge');
    expect(state?.category).toBe('read');
  });

  test('includes browser.canvas_screenshot as a read tool', () => {
    const cs = TOOL_CATALOGUE.find((t) => t.name === 'browser.canvas_screenshot');
    expect(cs).toBeDefined();
    expect(cs?.family).toBe('bridge');
    expect(cs?.category).toBe('read');
  });
});

describe('knowledge-loop tools (wrap_up, read, feedback)', () => {
  test('wrap_up and feedback are bridge writes; read is eval; readonly disables all three', () => {
    const meta = (name: string) => TOOL_CATALOGUE.find((t) => t.name === name);
    expect(meta('browser.wrap_up')).toMatchObject({ family: 'bridge', category: 'write' });
    expect(meta('browser.feedback')).toMatchObject({ family: 'bridge', category: 'write' });
    expect(meta('browser.read')).toMatchObject({ family: 'bridge', category: 'eval' });
    const readonly = getPreset('readonly').disabled;
    for (const name of ['browser.wrap_up', 'browser.feedback', 'browser.read']) {
      expect(readonly).toContain(name);
      expect(isKnownTool(name)).toBe(true);
    }
  });
});

describe('browser.screenshot catalogue entry', () => {
  test('is a read tool', () => {
    const s = TOOL_CATALOGUE.find((t) => t.name === 'browser.screenshot');
    expect(s?.family).toBe('bridge');
    expect(s?.category).toBe('read');
  });
});

describe('isToolEnabled', () => {
  test('returns true when disabled list is empty or undefined', () => {
    expect(isToolEnabled('browser.evaluate', undefined)).toBe(true);
    expect(isToolEnabled('browser.evaluate', [])).toBe(true);
  });

  test('returns false only when the exact name is in the disabled list', () => {
    expect(isToolEnabled('browser.evaluate', ['browser.evaluate'])).toBe(false);
    expect(isToolEnabled('browser.snapshot', ['browser.evaluate'])).toBe(true);
  });
});

describe('sanitizeDisabledTools', () => {
  test('returns [] for undefined / empty / all-unknown input', () => {
    expect(sanitizeDisabledTools(undefined)).toEqual([]);
    expect(sanitizeDisabledTools([])).toEqual([]);
    expect(sanitizeDisabledTools(['nope', 'also.nope'])).toEqual([]);
  });

  test('drops unknown tool names, keeps known ones', () => {
    const out = sanitizeDisabledTools(['browser.evaluate', 'foo.bar', 'browser.snapshot']);
    expect(out).toEqual(['browser.evaluate', 'browser.snapshot']);
  });

  test('dedupes and sorts', () => {
    const out = sanitizeDisabledTools(['browser.snapshot', 'browser.evaluate', 'browser.snapshot']);
    expect(out).toEqual(['browser.evaluate', 'browser.snapshot']);
  });

  test('ignores non-string entries defensively', () => {
    const out = sanitizeDisabledTools([
      'browser.evaluate',

      123 as unknown as string,

      null as unknown as string,
    ]);
    expect(out).toEqual(['browser.evaluate']);
  });
});

describe('isKnownTool', () => {
  test('true for every entry in the catalogue', () => {
    for (const t of TOOL_CATALOGUE) {
      expect(isKnownTool(t.name)).toBe(true);
    }
  });

  test('false for unrelated names', () => {
    expect(isKnownTool('foo.bar')).toBe(false);
    expect(isKnownTool('')).toBe(false);
  });
});

describe('PRESETS', () => {
  test('all four presets are present and uniquely identified', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids).toEqual(['all', 'readonly', 'no-eval', 'no-map']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the "all" preset disables nothing', () => {
    expect(getPreset('all').disabled).toEqual([]);
  });

  test('"readonly" disables every action + eval + map-write + write tool', () => {
    const out = new Set(getPreset('readonly').disabled);
    for (const t of TOOL_CATALOGUE) {
      const shouldBeDisabled =
        t.category === 'action' ||
        t.category === 'eval' ||
        t.category === 'map-write' ||
        t.category === 'write';
      expect(out.has(t.name)).toBe(shouldBeDisabled);
    }
  });

  test('"no-eval" disables exactly browser.evaluate', () => {
    expect(getPreset('no-eval').disabled).toEqual(['browser.evaluate']);
  });

  test('"no-map" disables every map tool and leaves the bridge alone', () => {
    const out = new Set(getPreset('no-map').disabled);
    for (const t of TOOL_CATALOGUE) {
      expect(out.has(t.name)).toBe(t.family === 'map');
    }
  });

  test('every preset names tools that exist in the catalogue', () => {
    const known = new Set(TOOL_CATALOGUE.map((t) => t.name));
    for (const p of PRESETS) {
      for (const name of p.disabled) {
        expect(known.has(name)).toBe(true);
      }
    }
  });

  test('getPreset throws for unknown ids', () => {
    expect(() => getPreset('bogus' as any)).toThrow(/Unknown preset/);
  });
});
