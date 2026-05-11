import {
  forget,
  listApps,
  recall,
  recordUse,
  renameApp,
  saveEntry,
  type EntryKind,
} from './queries.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MAP_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser.map.recall',
    description:
      'Recall what is already known about a browser app/route from the local map DB. Call this first when you arrive at a tab so you can reuse known selectors, flows and gotchas instead of rediscovering them. Pass origin (scheme://host:port). Optionally pass app_key to disambiguate when multiple apps share an origin, and url to filter entries down to a specific pathname.',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'scheme://host:port of the tab.' },
        app_key: {
          type: 'string',
          description:
            'Optional. Slug identifying the app within the origin (e.g. "flight-managment"). If omitted, the most-recently-seen app for the origin is used.',
        },
        url: {
          type: 'string',
          description: 'Optional full URL; only its pathname is used to filter entries.',
        },
      },
      required: ['origin'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.map.save',
    description:
      'Persist something learned about a browser app. Three kinds are supported: "selector" (a CSS selector tied to a purpose), "flow" (an ordered list of steps to reach an outcome), and "gotcha" (a free-form note). Saving auto-creates the app row if needed (app_key is derived from title when not provided). Upsert on (app, url_pattern, kind, purpose). Marks verified_at = now and clears failed_at. Never save selectors or flows you have not just successfully executed.',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string' },
        app_key: {
          type: 'string',
          description: 'Optional slug. If omitted, derived from title or origin host.',
        },
        title: {
          type: 'string',
          description: 'Optional document.title; used to derive app_key on first save for this origin.',
        },
        url_pattern: {
          type: 'string',
          description:
            'Pathname this entry applies to (e.g. "/home/flight-management/cga"). Use exact paths by default; only generalize when you have evidence of a parametric route.',
        },
        kind: { type: 'string', enum: ['selector', 'flow', 'gotcha'] },
        purpose: {
          type: 'string',
          description: 'Human-readable label for what this entry achieves (e.g. "open task detail dialog").',
        },
        payload: {
          description:
            'Kind-specific payload. selector: { selector: string, evidence?: string }. flow: { steps: array<{action,...}>}. gotcha: { body: string }.',
        },
        notes: { type: 'string' },
      },
      required: ['origin', 'url_pattern', 'kind', 'purpose', 'payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.map.record_use',
    description:
      'Mark an entry as freshly verified or freshly failed after you used it. ok=true updates verified_at and clears failed_at; ok=false updates failed_at. Always call this after using an entry from recall so the map stays honest about what works today.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'number' },
        ok: { type: 'boolean' },
        notes: { type: 'string' },
      },
      required: ['entry_id', 'ok'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.map.forget',
    description:
      'Permanently delete an entry (entry_id) or a whole app and all its entries (app_id). Use when a refactor or app change makes the saved knowledge actively wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'number' },
        app_id: { type: 'number' },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser.map.rename_app',
    description:
      'Rename an app_key. Useful when the heuristic from the document title picked a poor name (e.g. typos like "FLIGHT MANAGMENT" → "flight-management").',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'number' },
        new_app_key: { type: 'string' },
      },
      required: ['app_id', 'new_app_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.map.apps',
    description:
      'List apps currently tracked in the map, most recently used first. Use to discover known origins and their app_keys.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

interface RecallArgs {
  origin: string;
  app_key?: string;
  url?: string;
}

interface SaveArgs {
  origin: string;
  app_key?: string;
  title?: string;
  url_pattern: string;
  kind: EntryKind;
  purpose: string;
  payload: unknown;
  notes?: string;
}

interface RecordUseArgs {
  entry_id: number;
  ok: boolean;
  notes?: string;
}

interface ForgetArgs {
  entry_id?: number;
  app_id?: number;
  reason?: string;
}

interface RenameArgs {
  app_id: number;
  new_app_key: string;
}

export function isMapTool(name: string): boolean {
  return name.startsWith('browser.map.');
}

export function handleMapTool(name: string, args: unknown): unknown {
  switch (name) {
    case 'browser.map.recall': {
      const a = args as RecallArgs;
      return recall({ origin: a.origin, app_key: a.app_key ?? null, url: a.url ?? null });
    }
    case 'browser.map.save': {
      const a = args as SaveArgs;
      return saveEntry({
        origin: a.origin,
        app_key: a.app_key ?? null,
        title: a.title ?? null,
        url_pattern: a.url_pattern,
        kind: a.kind,
        purpose: a.purpose,
        payload: a.payload,
        notes: a.notes ?? null,
      });
    }
    case 'browser.map.record_use': {
      const a = args as RecordUseArgs;
      return recordUse({ entry_id: a.entry_id, ok: a.ok, notes: a.notes ?? null });
    }
    case 'browser.map.forget': {
      const a = args as ForgetArgs;
      return forget({ entry_id: a.entry_id, app_id: a.app_id, reason: a.reason });
    }
    case 'browser.map.rename_app': {
      const a = args as RenameArgs;
      return renameApp(a.app_id, a.new_app_key);
    }
    case 'browser.map.apps': {
      return listApps();
    }
    default:
      throw new Error(`Unknown map tool: ${name}`);
  }
}
