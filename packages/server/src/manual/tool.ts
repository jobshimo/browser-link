/**
 * `browser.manual` — the agent manual on demand. Server-only: it reads the
 * tool definitions, the topics and the instructions-block status, never a
 * tab or the bridge.
 *
 *  - no arguments → the index: version, block status per client, one line
 *    per tool, the topic list;
 *  - `{ tool }` → that tool's `doc` plus one line per `inputSchema` property;
 *  - `{ topic }` → one hand-written topic.
 */

import { VERSION } from '../version.js';
import { BROWSER_TOOL_DEFINITIONS } from '../tools/browser-definitions.js';
import { MAP_TOOL_DEFINITIONS } from '../map/tools.js';
import type { ToolDefinition } from '../tools/types.js';
import { renderTool } from './render.js';
import { TOPICS, TOPIC_NAMES, renderTopic, type TopicName } from './topics.js';
import { formatClientStatus, type ClientInstructionsStatus } from './status.js';

export interface ManualOptions {
  /** Current block status per client (read-only detection). */
  statuses: () => readonly ClientInstructionsStatus[];
}

/** Text up to and including the first sentence end followed by a capital
 * letter or the end of the text, so "e.g. `x`" does not cut it short. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^.*?[.!?](?=\s+[A-Z]|$)/.exec(flat);
  return m ? m[0] : flat;
}

function allTools(): ToolDefinition[] {
  return [...BROWSER_TOOL_DEFINITIONS, ...MAP_TOOL_DEFINITIONS];
}

function renderIndex(statuses: readonly ClientInstructionsStatus[]): string {
  const lines = [`browser-link ${VERSION}`, '', 'Instructions block:'];
  if (statuses.length === 0) lines.push('- (no client detected)');
  for (const s of statuses) lines.push(`- ${formatClientStatus(s)}`);
  lines.push('', 'Tools (`browser.manual({ tool })` for one):');
  for (const def of allTools()) {
    lines.push(`- ${def.name} — ${firstSentence(def.doc?.purpose ?? def.description)}`);
  }
  lines.push('', 'Topics (`browser.manual({ topic })` for one):');
  for (const name of TOPIC_NAMES) lines.push(`- ${name} — ${TOPICS[name].title}`);
  return lines.join('\n');
}

function schemaType(schema: Record<string, unknown>): string {
  const t = schema.type;
  if (Array.isArray(t)) return t.join('|');
  if (t === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    return items && typeof items.type === 'string' ? `${items.type}[]` : 'array';
  }
  if (typeof t === 'string') return t;
  const alts = (schema.oneOf ?? schema.anyOf) as Record<string, unknown>[] | undefined;
  if (Array.isArray(alts)) return alts.map(schemaType).join('|');
  return 'any';
}

function renderParameters(def: ToolDefinition): string {
  const props = (def.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((def.inputSchema.required as string[] | undefined) ?? []);
  const names = Object.keys(props);
  if (names.length === 0) return '**Parameters:** none';
  const lines = ['**Parameters:**'];
  for (const name of names) {
    const p = props[name];
    const head = `- ${name} (${schemaType(p)}, ${required.has(name) ? 'required' : 'optional'})`;
    const desc = typeof p.description === 'string' ? firstSentence(p.description) : '';
    lines.push(desc ? `${head}: ${desc}` : head);
  }
  return lines.join('\n');
}

function renderToolManual(name: string): string {
  const def = allTools().find((d) => d.name === name);
  if (!def) {
    throw new Error(
      `Unknown tool "${name}". Valid names: ${allTools()
        .map((d) => d.name)
        .join(', ')}`,
    );
  }
  const doc = renderTool(def) ?? `### ${def.name}\n\n${def.description}`;
  return `${doc}\n\n${renderParameters(def)}`;
}

function isTopicName(name: string): name is TopicName {
  return (TOPIC_NAMES as readonly string[]).includes(name);
}

/** Render `browser.manual`'s answer for `args`; throws on invalid input. */
export function renderManual(args: unknown, opts: ManualOptions): string {
  const { tool, topic } = (args ?? {}) as { tool?: unknown; topic?: unknown };
  if (tool !== undefined && topic !== undefined) {
    throw new Error('browser.manual takes either `tool` or `topic`, not both.');
  }
  if (tool !== undefined) {
    if (typeof tool !== 'string') throw new Error('browser.manual: `tool` must be a string.');
    return renderToolManual(tool);
  }
  if (topic !== undefined) {
    if (typeof topic !== 'string') throw new Error('browser.manual: `topic` must be a string.');
    if (!isTopicName(topic)) {
      throw new Error(`Unknown topic "${topic}". Valid topics: ${TOPIC_NAMES.join(', ')}`);
    }
    return renderTopic(topic);
  }
  return renderIndex(opts.statuses());
}
