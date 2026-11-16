import type { ExtensionToServer } from '../messages.js';

/*
 * Runtime check of a frame from an accepted extension socket.
 *
 * `JSON.parse` yields `unknown`; the bridge used to cast it to
 * `ExtensionToServer` and read fields as if the type were enforced. This
 * module is the enforcement: a known `kind` and, for that kind, the fields the
 * handler dereferences with the type it expects. It lives here (server only)
 * because `messages.ts` is byte-guarded against the extension's copy.
 *
 * Fields a handler already validates itself (the contents of a
 * `flow.recorded` payload, the optional filters of an `activity.query`) are
 * not re-checked beyond what is needed to dereference them safely.
 */

export type FrameCheck = { ok: true; msg: ExtensionToServer } | { ok: false; kind: string };

type Frame = Record<string, unknown>;

function isRecord(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptional = (value: unknown, test: (v: unknown) => boolean): boolean =>
  value === undefined || test(value);

/** Per-kind shape test. Each returns whether the handler for that kind can
 * read its fields safely. */
const SHAPES: Record<ExtensionToServer['kind'], (f: Frame) => boolean> = {
  'tab.register': (f) =>
    isRecord(f.payload) && isString(f.payload.url) && isString(f.payload.title),
  'tool.response': (f) =>
    isString(f.id) && typeof f.ok === 'boolean' && (f.ok || isString(f.error)),
  'bridge.event': (f) => isString(f.eventKind) && isRecord(f.data) && isOptional(f.tabId, isString),
  'flow.recorded': (f) => isRecord(f.payload),
  'activity.query': (f) => isString(f.request_id) && isOptional(f.query, isRecord),
  'activity.purge': (f) => isString(f.request_id),
  'bridge.repair': (f) => isString(f.request_id),
  'admin.describe': (f) => isString(f.request_id),
  'admin.action': (f) => isString(f.request_id) && isString(f.id),
};

function isKnownKind(kind: unknown): kind is ExtensionToServer['kind'] {
  return isString(kind) && Object.hasOwn(SHAPES, kind);
}

/**
 * Check one parsed frame. On failure `kind` is the frame's `kind` when it is
 * a known one and `unknown` otherwise, so a log line never echoes
 * attacker-chosen text or any payload.
 */
export function checkExtensionFrame(value: unknown): FrameCheck {
  if (!isRecord(value) || !isKnownKind(value.kind)) return { ok: false, kind: 'unknown' };
  if (!SHAPES[value.kind](value)) return { ok: false, kind: value.kind };
  return { ok: true, msg: value as unknown as ExtensionToServer };
}
