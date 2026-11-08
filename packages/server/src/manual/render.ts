/**
 * Renderers for the agent manual. One source, three outputs:
 *
 *  - `renderServerInstructions` — the MCP `initialize.instructions` text:
 *    the core first (hosts truncate this text, so what comes first is what
 *    arrives), then one section per tool rendered from its `doc` block.
 *  - `renderInstallBody` — the body of the block `browser-link instructions
 *    install` writes into each client's instructions file: the core, then
 *    the topics an agent needs every session.
 *  - `renderTopic` (in `topics.ts`) — one topic on demand.
 */

import { BROWSER_TOOL_DEFINITIONS } from '../tools/browser-definitions.js';
import { MAP_TOOL_DEFINITIONS } from '../map/tools.js';
import type { ToolDefinition } from '../tools/types.js';
import { renderCore, type CoreOptions } from './core.js';
import { renderTopic, type TopicName } from './topics.js';

/** Topics embedded in the installed block, in order. The block is read in
 * full every session, so these are the ones worth that cost. */
const INSTALL_TOPICS: readonly TopicName[] = ['token-efficiency', 'downloads', 'flows', 'map'];

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

/** The installed block body as single lines: the core, then the install
 * topics, each separated by one blank line. */
export function renderInstallBody(): string[] {
  const text = [renderCore({}), ...INSTALL_TOPICS.map(renderTopic)].join('\n\n');
  return text.split('\n');
}
