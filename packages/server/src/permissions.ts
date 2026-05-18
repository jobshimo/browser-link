/**
 * Tool access control — single source of truth for which MCP tools
 * browser-link exposes and how the user can narrow that down.
 *
 * The runtime answer to "is this tool allowed?" is computed from the
 * `disabledTools` list in `config.json` (default: empty = everything
 * allowed). The catalogue below adds human-readable metadata used by
 * the UI and the CLI subcommand — it never affects what the MCP server
 * returns by itself.
 */

export type ToolFamily = 'bridge' | 'map';

/** Coarse-grained behaviour bucket — used by presets, not by the runtime
 * filter. The runtime only cares about the exact tool name. */
export type ToolCategory = 'read' | 'action' | 'eval' | 'map-read' | 'map-write';

export interface ToolMeta {
  name: string;
  family: ToolFamily;
  category: ToolCategory;
  summary: string;
}

export const TOOL_CATALOGUE: readonly ToolMeta[] = [
  // Browser bridge — read-only
  { name: 'browser.list_tabs', family: 'bridge', category: 'read', summary: 'List connected tabs' },
  {
    name: 'browser.my_tabs',
    family: 'bridge',
    category: 'read',
    summary: 'List tabs currently claimed by the calling agent',
  },
  {
    name: 'browser.events',
    family: 'bridge',
    category: 'read',
    summary: 'Read the bridge lifecycle event log (recovery + audit)',
  },
  {
    name: 'browser.ping',
    family: 'bridge',
    category: 'read',
    summary: 'Verify the bridge to a tab',
  },
  {
    name: 'browser.snapshot',
    family: 'bridge',
    category: 'read',
    summary: 'Dump DOM, text and interactive elements',
  },
  {
    name: 'browser.console',
    family: 'bridge',
    category: 'read',
    summary: 'Read recent console messages',
  },
  {
    name: 'browser.network',
    family: 'bridge',
    category: 'read',
    summary: 'Read recent network requests',
  },
  {
    name: 'browser.network_body',
    family: 'bridge',
    category: 'read',
    summary: 'Fetch the body of a specific request',
  },
  {
    name: 'browser.wait_for',
    family: 'bridge',
    category: 'read',
    summary: 'Wait for a selector, JS expression, or network request',
  },
  {
    name: 'browser.wait_for_tab',
    family: 'bridge',
    category: 'read',
    summary: 'Wait for a new tab opened by an action of the agent',
  },

  // Browser bridge — actions
  {
    name: 'browser.navigate',
    family: 'bridge',
    category: 'action',
    summary: 'Navigate the tab to a URL',
  },
  {
    name: 'browser.click',
    family: 'bridge',
    category: 'action',
    summary: 'Click an element by CSS selector',
  },
  {
    name: 'browser.type',
    family: 'bridge',
    category: 'action',
    summary: 'Type text into an input',
  },
  {
    name: 'browser.drag',
    family: 'bridge',
    category: 'action',
    summary: 'Drag an element to another element or coordinate',
  },
  {
    name: 'browser.dialog_respond',
    family: 'bridge',
    category: 'action',
    summary: 'Respond to a pending native dialog (alert/confirm/prompt)',
  },
  {
    name: 'browser.set_permission',
    family: 'bridge',
    category: 'action',
    summary: 'Grant or deny a browser permission for an origin (geo, notifs, etc.)',
  },
  {
    name: 'browser.claim_tab',
    family: 'bridge',
    category: 'action',
    summary: 'Reserve a tab cooperatively under the calling agent',
  },
  {
    name: 'browser.release_tab',
    family: 'bridge',
    category: 'action',
    summary: 'Release a tab claim',
  },
  {
    name: 'browser.reset',
    family: 'bridge',
    category: 'action',
    summary: 'Soft-reset the bridge state (drops all tabs / claims / events)',
  },

  // Browser bridge — arbitrary code
  {
    name: 'browser.evaluate',
    family: 'bridge',
    category: 'eval',
    summary: 'Run arbitrary JavaScript in the page',
  },

  // Persistent map — reads
  {
    name: 'browser.map.recall',
    family: 'map',
    category: 'map-read',
    summary: 'Recall selectors / flows / gotchas for an app',
  },
  { name: 'browser.map.apps', family: 'map', category: 'map-read', summary: 'List known apps' },

  // Persistent map — writes
  {
    name: 'browser.map.save',
    family: 'map',
    category: 'map-write',
    summary: 'Persist a selector / flow / gotcha',
  },
  {
    name: 'browser.map.record_use',
    family: 'map',
    category: 'map-write',
    summary: 'Mark an entry verified or failed',
  },
  {
    name: 'browser.map.forget',
    family: 'map',
    category: 'map-write',
    summary: 'Delete an entry or a whole app',
  },
  {
    name: 'browser.map.rename_app',
    family: 'map',
    category: 'map-write',
    summary: 'Rename an app_key',
  },
];

export type PresetId = 'all' | 'readonly' | 'no-eval' | 'no-map';

export interface PresetDef {
  id: PresetId;
  label: string;
  /** Which tool names this preset disables. */
  disabled: readonly string[];
}

function namesWhere(predicate: (m: ToolMeta) => boolean): string[] {
  return TOOL_CATALOGUE.filter(predicate)
    .map((m) => m.name)
    .sort();
}

export const PRESETS: readonly PresetDef[] = [
  { id: 'all', label: 'All enabled', disabled: [] },
  {
    id: 'readonly',
    label: 'Read-only (no actions, no JS, no map writes)',
    disabled: namesWhere(
      (m) => m.category === 'action' || m.category === 'eval' || m.category === 'map-write',
    ),
  },
  {
    id: 'no-eval',
    label: 'No evaluate (everything except arbitrary JS)',
    disabled: ['browser.evaluate'],
  },
  {
    id: 'no-map',
    label: 'No persistent map (all bridge tools on)',
    disabled: namesWhere((m) => m.family === 'map'),
  },
];

const KNOWN_NAMES: ReadonlySet<string> = new Set(TOOL_CATALOGUE.map((m) => m.name));

/** True when the tool should be exposed in tools/list and accepted in tools/call. */
export function isToolEnabled(name: string, disabled: readonly string[] | undefined): boolean {
  if (!disabled || disabled.length === 0) return true;
  return !disabled.includes(name);
}

/** Drop entries that don't match any current tool, dedupe, and sort. Used
 * before writing the list to disk and after reading it back, so unknown
 * names from older or newer versions never poison the runtime. */
export function sanitizeDisabledTools(input: readonly string[] | undefined): string[] {
  if (!input || input.length === 0) return [];
  const out = new Set<string>();
  for (const name of input) {
    if (typeof name === 'string' && KNOWN_NAMES.has(name)) out.add(name);
  }
  return [...out].sort();
}

export function getPreset(id: PresetId): PresetDef {
  const found = PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown preset: ${id}`);
  return found;
}

export function isKnownTool(name: string): boolean {
  return KNOWN_NAMES.has(name);
}
