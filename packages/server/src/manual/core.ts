/**
 * The hand-written core of the agent manual: the rules an agent needs at the
 * moment it uses the browser. It reaches the agent three ways: as the second
 * text block of the first browser tool call of a session, first in the MCP
 * `initialize.instructions` (hosts truncate that text), and in the installed
 * block only when the owner chose `browser-link instructions install
 * --with-core`. Pinned at 2,000 characters by `manual.test.ts`.
 *
 * Rule for editing: a line stays only when it changes what the agent does
 * next, and it names the failure it prevents. Depth lives in the per-tool
 * `doc` blocks and in `topics.ts`, reachable through `browser.manual`.
 *
 * The eight curation rules mirror, number for number, what the server
 * enforces on `browser.wrap_up`; keep both in step.
 */

import { TOPIC_NAMES } from './topics.js';

/** First line of the core; tests and the start-time notice anchor on it. */
export const CORE_HEADING = '## browser-link rules';

const CORE_LINES: readonly string[] = [
  CORE_HEADING,
  'Use `browser.*` when the request involves a web page: a URL, site, tab, form, dialog, layout or UI element, or "X doesn\'t work" / "no anda X" in a web app. Answering without looking gets the page wrong.',
  "- Call `browser.list_tabs` first and read each tab's `knowledge` (pitfalls, readers, flows, selectors with `confidence`); skipping it repeats mistakes already recorded.",
  '- `ok` is not proof: a `hit_element` that is not your target means the click missed; `settle.settled: false` or `mutation_count: 0` means quiet, not effect. Pass `expect` when the effect matters, or you build on an action that did nothing.',
  '- Act on the `ref` from your last `snapshot`/`find`; a remembered selector or an old ref hits the wrong element.',
  '- Before writing JS, try `browser.find`, `browser.read({ name })` and `browser.flow({ name })`: `evaluate` costs tokens and teaches the map nothing.',
  '- Downloads only through `browser.download`; a click can open a Save dialog no tool can close.',
  '- Before you answer the user after using the browser, call `browser.wrap_up`, then again with your decisions. `pending_wrap_up: n` on a result means n items wait for it; skipping it loses what this session learned.',
  'Curation (the server rejects a violation, naming the rule):',
  '1. Only what worked enters knowledge; failures stay as evidence.',
  "2. Keep a reader only if it is reusable without this task's data; data literals become `<PLACEHOLDER>` templates.",
  '3. Never credentials, tokens, cookies, storage or personal data, even as structure; mutations are never readers.',
  '4. Names say what is returned: kebab-case, ≤ 40 chars, no verbs.',
  '5. One-offs are dropped by default.',
  '6. A pitfall is a server-generated candidate you confirm, never free text.',
  '7. Nothing about the user, only how the app works.',
  '8. In doubt, drop.',
  `Depth: \`browser.manual()\` (index), \`browser.manual({ tool })\`, \`browser.manual({ topic })\`: ${TOPIC_NAMES.join(', ')}.`,
];

export interface CoreOptions {
  /** One line placed before everything else, e.g. an outdated-block notice. */
  notice?: string;
}

/** The core as one string; the optional notice is its first line. */
export function renderCore(opts: CoreOptions = {}): string {
  const lines = opts.notice ? [opts.notice, '', ...CORE_LINES] : CORE_LINES;
  return lines.join('\n');
}
