// The committed normalise table of the differential check (design 7(b)):
// what may differ between two runs of the same build and is therefore
// rewritten before two call records (run.mjs E2E_RECORD) are compared by
// scripts/e2e-diff.mjs. Anything not listed here is compared as is; error
// strings get no rule beyond these. A self-diff difference is fixed here (in
// a reviewed commit) or made deterministic in the fixture, never ignored.
import { createHash } from 'node:crypto';

/** Identifiers renamed by first appearance, keeping identity: the same value
 * gets the same `<kind#n>` everywhere in one record. Key -> kind. */
export const ID_KEYS = {
  tab_id: 'tab',
  tabId: 'tab',
  doc_id: 'doc',
  flow_id: 'flow',
  request_id: 'request',
  requestId: 'request',
  download_id: 'download',
  downloadId: 'download',
  mark: 'mark',
  observer_mark: 'mark',
  loaderId: 'loader',
  frameId: 'frame',
  targetId: 'target',
  backendNodeId: 'node',
  executionContextId: 'context',
  scriptId: 'script',
  pid: 'pid',
  agentPid: 'pid',
};

/** Keys whose value is `<doc id>:<suffix>` (the suffix is kept). */
export const DOC_SCOPED_KEYS = ['snapshot_id'];

/** A ref (`ggz92g:e12`): its prefix is per document, the element number is kept. */
export const REF_PATTERN = /^([a-z0-9]{4,}):(e\d+)$/;

/** Timing keys: the value becomes `<ms>`. */
export const TIME_KEYS = ['elapsedMs', 'durationMs', 'started_at', 'finished_at', 'timestamp'];
/** Keys ending in `_ms` (or `_ms_<word>`, such as drag's `duration_ms_actual`). */
export const TIME_KEY_PATTERN = /_ms(_[a-z]+)?$/;
/** A number above 1e12 (epoch ms) under a snake_case key ending in `_at`
 * becomes `<ms>` (the runs show `expires_at` and `ended_at`; `started_at` and
 * `finished_at` are also in TIME_KEYS). Anchored: `format`, `stat` or
 * `limit` never match. */
export const EPOCH_KEY_PATTERN = /^[a-z]+(_[a-z]+)*_at$/;

/** Counts that measure timing, per tool, at the top of the result: they
 * become `<count>`. `wait_for.checks` is how many polls ran before the
 * condition held (2 or 3 between two runs of the same build). */
export const TIMING_COUNTS = { 'browser.wait_for': ['checks'] };

/** browser-link's own release number: a release bump in the base or HEAD is
 * not a behavior change. Semver values under exactly these keys become
 * `<version>`; `extension_version` (list_tabs) is the only one the runs show. */
export const VERSION_KEYS = ['extension_version'];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** String rewrites, in order. */
export const STRING_RULES = [
  // ISO timestamps.
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, '<iso>'],
  // HTTP dates (the `Date` response header in network results).
  [
    /(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT/g,
    '<http-date>',
  ],
  // The harness's cache-busting query `?n=<Date.now()>` (or `&n=`): the only
  // epoch milliseconds the runs show inside a string.
  [/([?&]n=)1\d{12}(?!\d)/g, '$1<ms>'],
  // Loopback ports (any; the run's own ports are also replaced elsewhere).
  [/\b(127\.0\.0\.1|localhost):\d+/g, '$1:<port>'],
  // mkdtemp suffixes of harness temp dirs that are not in the record context.
  [/\b(bl-e2e-[a-z-]*?[a-z])-[A-Za-z0-9]{6}\b/g, '$1'],
];

/** Results of these tools interleave several sources by timing: their
 * entries are compared as sorted by canonical JSON (order inside one entry
 * is kept). */
export const UNORDERED_TOOLS = ['browser.console', 'browser.network', 'browser.events'];

/** JSON with sorted keys: equal values give equal strings. */
export function canonical(value) {
  if (value === undefined) return 'undefined';
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  }
  return v;
}

/** `{ format, width, height, sha256 }` for a base64 PNG, JPEG or WebP. */
export function imageSummary(b64, mimeType) {
  const bytes = Buffer.from(b64, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let format = mimeType ? mimeType.replace(/^image\//, '') : 'unknown';
  let width = null;
  let height = null;
  if (bytes.subarray(1, 4).toString('latin1') === 'PNG') {
    format = 'png';
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = 'jpeg';
    for (let at = 2; at + 9 < bytes.length;) {
      const marker = bytes[at + 1];
      const len = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        height = bytes.readUInt16BE(at + 5);
        width = bytes.readUInt16BE(at + 7);
        break;
      }
      at += 2 + len;
    }
  } else if (bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    format = 'webp';
  }
  return { format, width, height, sha256 };
}

const IMAGE_B64 = /^(iVBORw0KGgo|\/9j\/|UklGR)[A-Za-z0-9+/=]{60,}$/;
const DATA_URL = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/;

/** The run-specific values of one record (`context` written by run.mjs). */
function runContext(record) {
  const slash = (p) => p.replace(/\\/g, '/');
  const dirs = [];
  const home = record.context?.home;
  if (home) dirs.push([slash(home), '<home>']);
  for (const t of record.context?.temps ?? []) {
    if (t === home) continue;
    const base = slash(t).split('/').pop() ?? '';
    dirs.push([slash(t), `<tmp>/${base.replace(/-[A-Za-z0-9]{6}$/, '')}`]);
  }
  // Longest first, so a dir inside another is replaced before its parent.
  dirs.sort((a, b) => b[0].length - a[0].length);
  const chrome = /\d+\.\d+\.\d+\.\d+/.exec(record.chrome ?? '')?.[0];
  return {
    dirs,
    ports: (record.context?.ports ?? []).map(String),
    chrome,
    ids: new Map(), // kind -> Map(value -> name)
  };
}

function rename(ctx, kind, value) {
  if (value === null || value === undefined) return value;
  let names = ctx.ids.get(kind);
  if (!names) ctx.ids.set(kind, (names = new Map()));
  const key = String(value);
  if (!names.has(key)) names.set(key, `<${kind}#${String(names.size + 1)}>`);
  return names.get(key);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normaliseString(ctx, s) {
  const ref = REF_PATTERN.exec(s);
  if (ref) return `${rename(ctx, 'ref-doc', ref[1])}:${ref[2]}`;
  const image = DATA_URL.exec(s);
  if (image) return imageSummary(image[2], image[1]);
  if (IMAGE_B64.test(s)) return imageSummary(s);
  let out = s.replace(/\\/g, '/');
  for (const [dir, name] of ctx.dirs) out = out.replace(new RegExp(escapeRe(dir), 'gi'), name);
  out = out.replace(/(^|[^A-Za-z0-9])[A-Za-z]:\//g, '$1/');
  for (const [re, to] of STRING_RULES) out = out.replace(re, to);
  for (const port of ctx.ports) {
    out = out.replace(new RegExp(`(?<![\\d.])${port}(?![\\d.])`, 'g'), '<port>');
  }
  if (ctx.chrome) out = out.split(ctx.chrome).join('<chrome>');
  // Ids already seen keep their name inside free text (messages, URLs).
  for (const names of ctx.ids.values()) {
    for (const [value, name] of names) {
      if (value.length >= 6 && out.includes(value)) out = out.split(value).join(name);
    }
  }
  return out;
}

function isTimeKey(key) {
  return TIME_KEYS.includes(key) || TIME_KEY_PATTERN.test(key);
}

function normaliseValue(ctx, value, key = '') {
  if (Object.hasOwn(ID_KEYS, key) && (typeof value === 'string' || typeof value === 'number')) {
    return rename(ctx, ID_KEYS[key], value);
  }
  if (DOC_SCOPED_KEYS.includes(key) && typeof value === 'string') {
    const at = value.lastIndexOf(':');
    if (at > 0) return `${rename(ctx, 'doc', value.slice(0, at))}${value.slice(at)}`;
  }
  if (isTimeKey(key) && (typeof value === 'number' || typeof value === 'string')) return '<ms>';
  if (VERSION_KEYS.includes(key) && typeof value === 'string' && SEMVER.test(value)) {
    return '<version>';
  }
  if (typeof value === 'number') {
    if (value > 1e12 && EPOCH_KEY_PATTERN.test(key)) return '<ms>';
    if (/port/i.test(key) && ctx.ports.includes(String(value))) return '<port>';
    return value;
  }
  if (typeof value === 'string') return normaliseString(ctx, value);
  if (Array.isArray(value)) return value.map((v) => normaliseValue(ctx, v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = normaliseValue(ctx, value[k], k);
    return out;
  }
  return value;
}

/** Sort the entries of an unordered result: a top-level array, or each array
 * directly under the top-level object. The sort key masks run-specific values
 * with a throwaway context, so ids get their names in the sorted order. */
function sortEntries(ctx, body) {
  const order = (arr) => {
    const keyed = arr.map((entry) => {
      const scratch = { ...ctx, ids: new Map() };
      return { entry, key: canonical(normaliseValue(scratch, entry)) };
    });
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return keyed.map((k) => k.entry);
  };
  if (Array.isArray(body)) return order(body);
  if (body && typeof body === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(body)) out[k] = Array.isArray(v) ? order(v) : v;
    return out;
  }
  return body;
}

/** One MCP result: text blocks that hold JSON are parsed (`json`), image
 * blocks become their summary. */
function normaliseResult(ctx, tool, result) {
  if (!result || typeof result !== 'object') return result;
  const content = (result.content ?? []).map((block) => {
    if (block.type === 'image' && typeof block.data === 'string') {
      return { type: 'image', image: imageSummary(block.data, block.mimeType) };
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      let parsed;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        return { type: 'text', text: normaliseString(ctx, block.text) };
      }
      if (UNORDERED_TOOLS.includes(tool)) parsed = sortEntries(ctx, parsed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const k of TIMING_COUNTS[tool] ?? []) {
          if (typeof parsed[k] === 'number') parsed[k] = '<count>';
        }
      }
      return { type: 'text', json: normaliseValue(ctx, parsed) };
    }
    return normaliseValue(ctx, block);
  });
  return { content, ...(result.isError ? { isError: true } : {}) };
}

/** A run of `poll` calls with the same tool and arguments repeats until the
 * page is ready, so its length depends on timing: keep only the last. */
export function collapsePolls(calls) {
  return calls.filter((c, i) => {
    const next = calls[i + 1];
    return !(
      c.poll &&
      next?.poll &&
      next.tool === c.tool &&
      canonical(next.args) === canonical(c.args)
    );
  });
}

/** A raw E2E_RECORD file's content -> `{ ok, calls: [{ label, tool, args,
 * result | thrown }] }`, ready to be compared with canonical(). */
export function normaliseRecord(record) {
  const ctx = runContext(record);
  const calls = collapsePolls(record.calls ?? []).map((c) => {
    const out = { label: c.label ?? c.tool, tool: c.tool, args: normaliseValue(ctx, c.args) };
    if (c.thrown !== undefined) out.thrown = normaliseString(ctx, c.thrown);
    else out.result = normaliseResult(ctx, c.tool, c.result);
    return out;
  });
  return { ok: record.ok ?? null, calls };
}
