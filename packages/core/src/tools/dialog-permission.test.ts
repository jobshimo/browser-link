// The dialog_respond and set_permission entries (design 3.3, slice 16):
// each handler's result and error texts, the command the dialog input sends,
// and cdp-direct refusing both.
import { describe, expect, it } from 'vitest';
import { createManualClock, createMemoryContentSettings } from '../ports/contract/index.js';
import type { ContentSettings } from '../ports/content-settings.js';
import { TOOL_REGISTRY } from './catalog.js';
import { toolResponse } from './failure.js';
import { dispatchTool, type Transport } from './registry.js';
import type { Requirement, ToolDeps } from './requirement.js';

const EXTENSION: ReadonlySet<Requirement> = new Set<Requirement>([
  'dialog-input',
  'content-settings',
]);
const CDP: ReadonlySet<Requirement> = new Set<Requirement>(['evaluator', 'page']);

/** The content-setting keys Chrome 118 exposes among the mapped ones. */
const KNOWN = ['location', 'notifications', 'camera', 'microphone'];
const notExposed = (setting: string): string =>
  `chrome.contentSettings.${setting} is not exposed in this Chrome build`;

function deps(
  options: {
    responded?: unknown[][];
    respond?: () => Promise<void>;
    settings?: ContentSettings;
  } = {},
): ToolDeps {
  return {
    clock: createManualClock(),
    'dialog-input': {
      respond: (...args: unknown[]) => {
        options.responded?.push(args);
        return options.respond?.() ?? Promise.resolve();
      },
    },
    'content-settings': options.settings ?? createMemoryContentSettings(KNOWN, notExposed),
  } as unknown as ToolDeps;
}

function call(
  tool: string,
  params: unknown,
  given: ToolDeps = deps(),
  transport: Transport = 'extension',
) {
  return dispatchTool(
    TOOL_REGISTRY,
    transport === 'extension' ? EXTENSION : CDP,
    given,
    transport,
    tool,
    params,
  );
}

describe('dialog_respond', () => {
  it('responds once with accept and the prompt text, and answers accepted', async () => {
    const responded: unknown[][] = [];
    const outcome = await call(
      'dialog_respond',
      { accept: true, prompt_text: 'hi' },
      deps({ responded }),
    );
    expect(outcome).toEqual({ ok: true, result: { accepted: true } });
    expect(responded).toEqual([[true, 'hi']]);
  });

  it('reads accept strictly and drops a prompt text that is not a string', async () => {
    const responded: unknown[][] = [];
    const outcome = await call(
      'dialog_respond',
      { accept: 'yes', prompt_text: 7 },
      deps({ responded }),
    );
    expect(outcome).toEqual({ ok: true, result: { accepted: false } });
    expect(responded).toEqual([[false, undefined]]);
  });

  it("with no dialog showing, the page's error is the answer", async () => {
    const outcome = await call(
      'dialog_respond',
      { accept: true },
      deps({ respond: () => Promise.reject(new Error('No dialog is showing')) }),
    );
    expect(toolResponse('r1', outcome)).toEqual({
      kind: 'tool.response',
      id: 'r1',
      ok: false,
      error: 'No dialog is showing',
    });
  });
});

describe('set_permission', () => {
  it('writes the content setting for the origin pattern and answers what it applied', async () => {
    const settings = createMemoryContentSettings(KNOWN, notExposed);
    const outcome = await call(
      'set_permission',
      { origin: 'https://a.test', name: 'geolocation', state: 'granted' },
      deps({ settings }),
    );
    expect(outcome).toEqual({
      ok: true,
      result: {
        origin: 'https://a.test',
        name: 'geolocation',
        state: 'granted',
        applied_as: 'location',
      },
    });
    expect(settings.read('location', 'https://a.test/*')).toBe('allow');
  });

  it('keeps an origin that already ends in /*, and maps denied and prompt', async () => {
    const settings = createMemoryContentSettings(KNOWN, notExposed);
    await call(
      'set_permission',
      { origin: 'https://a.test/*', name: 'camera', state: 'denied' },
      deps({ settings }),
    );
    await call(
      'set_permission',
      { origin: 'https://b.test', name: 'notifications', state: 'prompt' },
      deps({ settings }),
    );
    expect(settings.read('camera', 'https://a.test/*')).toBe('block');
    expect(settings.read('notifications', 'https://b.test/*')).toBe('ask');
  });

  it.each([
    [
      { origin: 'https://a.test', name: 'midi', state: 'granted' },
      "set_permission: 'midi' is not supported by chrome.contentSettings in MV3. Supported names: geolocation, notifications, camera, microphone, clipboardReadWrite, clipboardSanitizedWrite, sensors.",
    ],
    [
      { origin: 'https://a.test', name: 'geolocation', state: 'maybe' },
      "set_permission: unknown state 'maybe' (expected granted | denied | prompt).",
    ],
    [
      { origin: 'https://a.test', name: 'sensors', state: 'granted' },
      'set_permission: chrome.contentSettings.sensors is not exposed in this Chrome build',
    ],
    [
      { origin: 'https://a.test', state: 'granted' },
      "set_permission: 'undefined' is not supported by chrome.contentSettings in MV3. Supported names: geolocation, notifications, camera, microphone, clipboardReadWrite, clipboardSanitizedWrite, sensors.",
    ],
  ])('%j fails with its unchanged text', async (params, error) => {
    const outcome = await call('set_permission', params);
    expect(toolResponse('r2', outcome)).toEqual({
      kind: 'tool.response',
      id: 'r2',
      ok: false,
      error,
    });
  });
});

describe('set_permission on a surface whose setting is a temporary override (parity G10)', () => {
  const NOTE = 'temporary override note';
  function temporary(): ContentSettings & { writes: string[][] } {
    const writes: string[][] = [];
    return {
      writes,
      temporaryNote: NOTE,
      set: (setting, primaryPattern, value) => {
        writes.push([setting, primaryPattern, value]);
        return Promise.resolve();
      },
    };
  }

  it('writes the same setting and answers the surface note with the result', async () => {
    const settings = temporary();
    const outcome = await call(
      'set_permission',
      { origin: 'https://a.test', name: 'geolocation', state: 'denied' },
      deps({ settings }),
    );
    expect(outcome).toEqual({
      ok: true,
      result: {
        origin: 'https://a.test',
        name: 'geolocation',
        state: 'denied',
        applied_as: 'location',
        note: NOTE,
      },
    });
    expect(settings.writes).toEqual([['location', 'https://a.test/*', 'block']]);
  });

  it('fails an unsupported name with the same text without the MV3 wording, writing nothing', async () => {
    const settings = temporary();
    const outcome = await call(
      'set_permission',
      { origin: 'https://a.test', name: 'midi', state: 'granted' },
      deps({ settings }),
    );
    expect(toolResponse('r3', outcome)).toEqual({
      kind: 'tool.response',
      id: 'r3',
      ok: false,
      error:
        "set_permission: 'midi' is not supported. Supported names: geolocation, notifications, camera, microphone, clipboardReadWrite, clipboardSanitizedWrite, sensors.",
    });
    expect(settings.writes).toEqual([]);
  });
});

describe('cdp-direct', () => {
  it.each([
    ['dialog_respond', 'dialog-input'],
    ['set_permission', 'content-settings'],
  ])('refuses %s as unsupported (it lacks %s)', async (tool, missing) => {
    const responded: unknown[][] = [];
    const outcome = await call(tool, { accept: true }, deps({ responded }), 'cdp-direct');
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'unsupported', tool, missing: [missing] },
    });
    expect(responded).toEqual([]);
  });
});
