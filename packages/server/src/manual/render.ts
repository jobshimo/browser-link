/**
 * Renderers for the agent manual. One source, four outputs:
 *
 *  - `renderTrigger` — the short block `browser-link instructions install`
 *    writes into each client's instructions file: what browser-link is and
 *    when to use it. It is read every session, so it stays under 600
 *    characters; the rules arrive with the first browser tool call.
 *  - `renderInstallBody` — that block's body: the trigger, plus the core
 *    when the owner chose `--with-core`.
 *  - `renderServerInstructions` — the MCP `initialize.instructions` text:
 *    the core first (hosts truncate this text, so what comes first is what
 *    arrives), then one section per tool rendered from its `doc` block.
 *  - `renderTopic` (in `topics.ts`) — one topic on demand.
 */

import { BROWSER_TOOL_DEFINITIONS } from '../tools/browser-definitions.js';
import { MAP_TOOL_DEFINITIONS } from '../map/tools.js';
import type { ToolDefinition } from '../tools/types.js';
import { renderCore, type CoreOptions } from './core.js';

const TRIGGER_LINES: readonly string[] = [
  '## browser-link',
  'browser-link lets you see and drive the Chrome tabs the user connected through its extension (`browser.*` tools). Use it when the user mentions a web page, site, URL, browser tab, form, dialog, layout or UI element, or says something in a web app does not work ("no anda", "se ve mal", "check if X works"). Never reason about a page you have not seen.',
  'Your first browser tool call returns the rules; `browser.manual()` has the rest.',
];

/** The installed trigger: what browser-link is, when to use it, and where
 * the rules come from. */
export function renderTrigger(): string {
  return TRIGGER_LINES.join('\n');
}

/** Render a single tool's documentation as a markdown section. Skips
 * tools without a `doc` block. */
export function renderTool(def: ToolDefinition): string | null {
  if (!def.doc) return null;
  const { purpose, when_to_use, gotchas, example } = def.doc;
  const lines: string[] = [`### ${def.name}`, '', purpose, '', '**When to use:**'];
  for (const w of when_to_use) lines.push(`- ${w}`);
  if (gotchas && gotchas.length > 0) {
    lines.push('', '**Gotchas:**');
    for (const g of gotchas) lines.push(`- ${g}`);
  }
  if (example !== undefined && example !== '') {
    lines.push('', '**Example:**', '```', example, '```');
  }
  return lines.join('\n');
}

/** The MCP `initialize.instructions` text: core, then `## Tools` and one
 * section per documented tool, browser tools first, then map tools. */
export function renderServerInstructions(opts: CoreOptions = {}): string {
  const all: ToolDefinition[] = [...BROWSER_TOOL_DEFINITIONS, ...MAP_TOOL_DEFINITIONS];
  const sections: string[] = [renderCore(opts), '', '## Tools'];
  for (const def of all) {
    const rendered = renderTool(def);
    if (rendered) sections.push('', rendered);
  }
  return sections.join('\n');
}

export interface InstallBodyOptions {
  /** Keep the core in the installed block after the trigger. */
  withCore?: boolean;
}

/** The installed block body as single lines: the trigger, then (with
 * `withCore`) one blank line and the core. Never a topic. */
export function renderInstallBody(opts: InstallBodyOptions = {}): string[] {
  const text = opts.withCore ? `${renderTrigger()}\n\n${renderCore({})}` : renderTrigger();
  return text.split('\n');
}
