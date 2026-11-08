import {
  forget,
  listApps,
  recall,
  recordUse,
  renameApp,
  saveEntry,
  saveFlow,
  inTransaction,
  saveInsight,
  upsertApp,
  type EntryKind,
  type FlowRow,
  type InsightKind,
  type InsightRow,
} from './queries.js';
import { semanticKeyProblem, validateFlowSteps } from '../tools/browser-dispatch.js';
import type { ToolDefinition } from '../tools/types.js';

export const MAP_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser.map.recall',
    description:
      'Recall what is already known about a browser app/route from the local map DB. Call this first when you arrive at a tab so you can reuse known selectors, flows and gotchas instead of rediscovering them. Pass origin (scheme://host:port). Optionally pass app_key to disambiguate when multiple apps share an origin, and url to filter entries down to a specific pathname. Response sections, in order: `pitfalls` (what does NOT work — read these first), `mechanisms` (how the app behaves underneath), `entries`, `flows`. `flows` are named browser.flow-replayable recipes saved for the app (`{ name, description, steps, use_count }`, not filtered by url) — adapt any placeholder text in `steps` (e.g. `type text "<QUERY>"`) to the real value before replaying with browser.flow. A selector entry whose payload carries `semantic_key` (`{ role, name, path }`) AND whose stored selector is a structural `:nth-of-type(` fallback is returned with `prefer: "semantic_key"` (computed at recall, never stored): target it with browser.find({ key: payload.semantic_key }) rather than the brittle selector.',
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
    doc: {
      purpose:
        'Reload selectors, flows and gotchas you previously learned about an app, so you do not rediscover them every session.',
      when_to_use: [
        'On any non-trivial debugging session on a web app the user mentioned — call this with the tab origin BEFORE speculating.',
        'When you arrive at a tab and need to know "what do I already know about this app".',
      ],
      gotchas: [
        'If recall returns entries with failed_at more recent than verified_at, treat them as suspect — re-verify with snapshot before reusing.',
        'After every interaction that used a map entry, call browser.map.record_use with { entry_id, ok } so the map stays honest.',
        'For a saved flow recipe: ADAPT its steps (substitute placeholder text for the real value) BEFORE calling browser.flow — never replay a placeholder-bearing recipe verbatim.',
      ],
      example: 'browser.map.recall({ origin: "https://app.example.com" })',
    },
  },
  {
    name: 'browser.map.save',
    description:
      'Persist something learned about a browser app. Three entry kinds are supported: "selector" (a CSS selector tied to a purpose), "flow" (a free-form note about a multi-step path), and "gotcha" (a free-form note). The entry fields (url_pattern, kind, purpose, payload) are optional AS A GROUP: pass all four, or omit all four to save only `flows`, `mechanisms` or `pitfalls` (no throwaway entry needed); a partial entry or a call carrying nothing to save is rejected. Saving auto-creates the app row if needed (app_key is derived from title when not provided). Upsert on (app, url_pattern, kind, purpose). Marks verified_at = now and clears failed_at. Never save selectors or flows you have not just successfully executed. Optionally pass `flows`: an array of NAMED, REPLAYABLE flow recipes (`{ name, description?, steps }`) — `steps` must follow the EXACT browser.flow step grammar and is validated with the same rules browser.flow itself enforces. Upserts on (app, name); saving an existing name replaces its steps/description. Distinct from the "flow" entry kind above: that is a free-form note, this is a structured, browser.flow-replayable recipe returned by browser.map.recall. Also optionally pass `mechanisms` (`{ key, description }`: how the app behaves underneath) and `pitfalls` (`{ key, description, symptom? }`: what does NOT work) — behaviour, never content. A "selector" entry payload may also carry `semantic_key` (`{ role, name, path }`, the value a browser.find single match returned for that element) next to the selector: save it when the selector is a structural `:nth-of-type(` fallback, never for an `ambiguous: true` entry (refused); browser.map.recall then marks such an entry `prefer: "semantic_key"`. Never save a `ref`: refs die with the document.',
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
          description:
            'Optional document.title; used to derive app_key on first save for this origin.',
        },
        url_pattern: {
          type: 'string',
          description:
            'Pathname this entry applies to (e.g. "/home/flight-management/cga"). Use exact paths by default; only generalize when you have evidence of a parametric route.',
        },
        kind: { type: 'string', enum: ['selector', 'flow', 'gotcha'] },
        purpose: {
          type: 'string',
          description:
            'Human-readable label for what this entry achieves (e.g. "open task detail dialog").',
        },
        payload: {
          description:
            'Kind-specific payload. selector: { selector: string, evidence?: string, semantic_key?: { role: string, name: string, path: array<{ tag: string, index: number }> } } — `semantic_key` is the `semantic_key` a browser.find single match returned for that element (path 1-8 steps, strings at most 200 chars); it is refused on an `ambiguous: true` entry. flow: { steps: array<{action,...}>}. gotcha: { body: string }.',
        },
        notes: { type: 'string' },
        flows: {
          type: 'array',
          description:
            'Optional named, replayable flow recipes for this app. Each `steps` array follows the EXACT browser.flow step grammar (find/click/type/press/wait_for/drag) and is rejected with the same validation browser.flow applies. Use placeholder text for free-text values instead of real domain data (e.g. `type text "<QUERY>"`) — agents substitute the placeholder before calling browser.flow. Upserts on (app, name).',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  'Stable, reusable name for this recipe (e.g. "open task detail dialog").',
              },
              description: { type: 'string' },
              steps: {
                type: 'array',
                description:
                  'Ordered find/click/type/press/wait_for/drag steps — browser.flow grammar.',
                items: { type: 'object' },
              },
            },
            required: ['name', 'steps'],
            additionalProperties: false,
          },
        },
        mechanisms: {
          type: 'array',
          description:
            'Optional. How the app behaves underneath — behaviour, never content. Allowed: "a GET of an item URL marks it complete server-side", "progress % is rendered client-side, not in the fetched HTML". Forbidden: real IDs, names, dates, URLs with real values, message text. Upserts on (app, key).',
          items: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description:
                  'Stable slug-like label (e.g. "get-marks-item-complete"), max 100 chars.',
              },
              description: { type: 'string', description: 'The behaviour, max 1000 chars.' },
            },
            required: ['key', 'description'],
            additionalProperties: false,
          },
        },
        pitfalls: {
          type: 'array',
          description:
            'Optional. What does NOT work or misleads — the most expensive thing to rediscover. Allowed: "click on the next-lesson link returns ok but does not navigate (onmouseup handler)", "the text \'lessons completed\' is always in the raw HTML (JS template) — false positive for enrolment detection". Forbidden: real IDs, names, dates or any domain data. Upserts on (app, key).',
          items: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Stable slug-like label (e.g. "next-link-click-noop"), max 100 chars.',
              },
              description: {
                type: 'string',
                description: 'What fails or misleads, max 1000 chars.',
              },
              symptom: {
                type: 'string',
                description: 'Optional. What you observe when you hit it, max 1000 chars.',
              },
            },
            required: ['key', 'description'],
            additionalProperties: false,
          },
        },
      },
      required: ['origin'],
      additionalProperties: false,
    },
    doc: {
      purpose:
        'Persist UI structure you just discovered — a selector, a note, a gotcha, and/or one or more named replayable flow recipes — keyed by app (and, for the entry, a url pattern).',
      when_to_use: [
        'After a non-trivial flow worked end-to-end (opened a dialog, completed a form, found a setting).',
        'You learned HOW the app works underneath, or hit something that does NOT work → save a `mechanisms` / `pitfalls` item on its own (omit url_pattern/kind/purpose/payload), not just a selector. A pitfall costs far more to rediscover than a selector.',
        'The multi-step path you just ran is worth replaying later as-is → attach it via `flows` so a future browser.map.recall can hand it straight to browser.flow.',
      ],
      gotchas: [
        'NEVER save selectors or flows you have not just successfully executed.',
        'NEVER store domain data (IDs, user names, dates, etc.). The map captures UI structure only — `flows` steps must use placeholders (`<QUERY>`, `<NAME>`) for any free-text value, never the real value you just typed.',
        'Use url_pattern = exact pathname by default; only promote to a glob if you have evidence of a parametric route.',
        'Give `purpose` a stable, reusable label ("open task detail dialog", not "open IB0311 detail"). Same rule for a flow recipe\'s `name`.',
        '`mechanisms` and `pitfalls` describe behaviour, never content. Allowed: "a GET of an item URL marks it complete server-side"; "click on the next link returns ok but does not navigate". Forbidden: "item 4812 is complete", "user jane@x.com is enrolled", any real ID, name, date or value. Use a stable `key`; re-saving the same key replaces it.',
        "A `flows` entry's `steps` is validated with the SAME rules browser.flow enforces — an invalid steps array is rejected before anything is written, including the base entry.",
      ],
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
    doc: {
      purpose:
        'Update verified_at / failed_at on a map entry after you reused it, so the next agent knows whether it still works.',
      when_to_use: [
        'Right after using any selector or gotcha entry you got from browser.map.recall.',
      ],
      gotchas: [
        'ok:true updates verified_at and clears failed_at. ok:false updates failed_at — keep the map honest about what works today.',
        "Scoped to entries (selector/flow-note/gotcha rows), NOT to the named flow recipes in `flows` — those track only `use_count` (no verified/failed distinction), a deliberately simpler model that this tool's ok:true/false contract does not map onto cleanly. Re-`browser.map.save` a recipe with the same name to refresh it.",
      ],
    },
  },
  {
    name: 'browser.map.forget',
    description:
      'Permanently delete an entry (entry_id), ONE mechanism/pitfall (insight: { app_id, kind, key } — the app_id, kind and key come straight from a browser.map.recall item), or a whole app and everything in it (app_id). Use when a refactor or app change makes the saved knowledge actively wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'number' },
        app_id: { type: 'number' },
        insight: {
          type: 'object',
          description: 'Delete a single saved mechanism or pitfall.',
          properties: {
            app_id: { type: 'number' },
            kind: { type: 'string', enum: ['mechanism', 'pitfall'] },
            key: { type: 'string' },
          },
          required: ['app_id', 'kind', 'key'],
          additionalProperties: false,
        },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    doc: {
      purpose: 'Delete a stale map entry, or wipe a whole app, after a refactor invalidated it.',
      when_to_use: ['A whole app got refactored and the saved knowledge is now actively wrong.'],
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
    doc: {
      purpose: 'Rename the app_key for an app row when the title-derived slug is wrong.',
      when_to_use: [
        'The initial slug derived from document.title is misleading (typo, generic name).',
      ],
    },
  },
  {
    name: 'browser.map.apps',
    description:
      'List apps currently tracked in the map, most recently used first. Use to discover known origins and their app_keys.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    doc: {
      purpose: 'List every app currently tracked in the map, most recently used first.',
      when_to_use: ['To discover which origins/app_keys the map already knows about.'],
    },
  },
];

interface RecallArgs {
  origin: string;
  app_key?: string;
  url?: string;
}

interface SaveFlowArg {
  name: string;
  description?: string;
  steps: unknown;
}

const ENTRY_KINDS: readonly EntryKind[] = ['selector', 'flow', 'gotcha'];

interface SaveArgs {
  origin: string;
  app_key?: string;
  title?: string;
  /** The four entry fields are optional as a group (see the handler). */
  url_pattern?: string;
  kind?: EntryKind;
  purpose?: string;
  payload?: unknown;
  notes?: string;
  /** Untrusted until narrowed — the IPC/proxy path in multi-agent mode
   * reaches handleMapTool without JSON-schema validation, so the handler
   * re-checks array/object shape at runtime before treating an entry as
   * a `SaveFlowArg`. */
  flows?: unknown;
  /** Untrusted until narrowed, same as `flows`. */
  mechanisms?: unknown;
  pitfalls?: unknown;
}

export const MAX_INSIGHT_KEY = 100;
export const MAX_INSIGHT_TEXT = 1000;

export interface ValidatedInsight {
  key: string;
  description: string;
  symptom: string | null;
}

/** Validate ONE mechanism/pitfall. Shared by `browser.map.save` and
 * `browser-link map import`, so an import file can never smuggle in what
 * save would reject. Throws an unprefixed message. `symptom: null` counts as
 * absent: recall returns `symptom: null`, and a recalled item must re-save
 * unchanged. */
export function parseInsight(item: unknown, kind: 'mechanism' | 'pitfall'): ValidatedInsight {
  if (typeof item !== 'object' || item === null) {
    throw new Error(`each ${kind} must be an object`);
  }
  const i = item as { key?: unknown; description?: unknown; symptom?: unknown };
  if (typeof i.key !== 'string' || i.key.trim().length === 0) {
    throw new Error(`each ${kind} requires a non-empty key`);
  }
  const key = i.key.trim();
  if (key.length > MAX_INSIGHT_KEY) {
    throw new Error(`${kind} key must be at most ${MAX_INSIGHT_KEY} chars`);
  }
  if (typeof i.description !== 'string' || i.description.trim().length === 0) {
    throw new Error(`${kind} "${key}" requires a non-empty description`);
  }
  if (i.description.length > MAX_INSIGHT_TEXT) {
    throw new Error(`${kind} "${key}" description must be at most ${MAX_INSIGHT_TEXT} chars`);
  }
  let symptom: string | null = null;
  if (i.symptom !== undefined && i.symptom !== null) {
    if (kind !== 'pitfall') {
      throw new Error(`only a pitfall takes a symptom (mechanism "${key}")`);
    }
    if (typeof i.symptom !== 'string') {
      throw new Error(`pitfall "${key}" symptom must be a string`);
    }
    if (i.symptom.length > MAX_INSIGHT_TEXT) {
      throw new Error(`pitfall "${key}" symptom must be at most ${MAX_INSIGHT_TEXT} chars`);
    }
    symptom = i.symptom;
  }
  return { key, description: i.description, symptom };
}

/** Shape-check `mechanisms` / `pitfalls` BEFORE anything is written (same
 * all-or-nothing rule as `flows`). Runs here, not only in the JSON schema,
 * because the IPC/proxy path in multi-agent mode skips schema validation. */
function validateInsights(raw: unknown, kind: 'mechanism' | 'pitfall'): ValidatedInsight[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`browser.map.save: ${kind}s must be an array`);
  return raw.map((item: unknown) => {
    try {
      return parseInsight(item, kind);
    } catch (err) {
      throw new Error(`browser.map.save: ${(err as Error).message}`, { cause: err });
    }
  });
}

interface RecordUseArgs {
  entry_id: number;
  ok: boolean;
  notes?: string;
}

interface ForgetInsightArg {
  app_id: number;
  kind: InsightKind;
  key: string;
}

interface ForgetArgs {
  entry_id?: number;
  app_id?: number;
  /** Untrusted until narrowed (no schema validation on the IPC path). */
  insight?: Partial<ForgetInsightArg> | null;
  reason?: string;
}

interface RenameArgs {
  app_id: number;
  new_app_key: string;
}

/**
 * An entry payload may carry `semantic_key: { role, name, path }` next to its
 * selector (spec v4 §6.3) — additive, inside the free-form JSON payload. When
 * present it must have the full key shape (`semanticKeyProblem` with `path`
 * required), and it is refused on an `ambiguous: true` entry: that selector
 * resolves first-match-wins across identical twins, so no key saved with it
 * could name one element either.
 */
function validatePayloadSemanticKey(payload: unknown, purpose: unknown, urlPattern: unknown): void {
  if (typeof payload !== 'object' || payload === null || !('semantic_key' in payload)) return;
  const p = payload as { semantic_key?: unknown; ambiguous?: unknown };
  const entry = `entry "${String(purpose)}" (${String(urlPattern)})`;
  if (p.ambiguous === true) {
    throw new Error(
      `browser.map.save: ${entry} has ambiguous: true and cannot store a semantic_key`,
    );
  }
  const problem = semanticKeyProblem(p.semantic_key, { requirePath: true });
  if (problem !== null) throw new Error(`browser.map.save: ${entry}: semantic_key ${problem}`);
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
      // Validate every flow recipe BEFORE writing anything — a steps array
      // browser.flow would reject must fail browser.map.save cleanly too,
      // without leaving a half-saved entry behind (see the reuse note on
      // `validateFlowSteps` in browser-dispatch.ts). The shape guards run
      // here and not just in the JSON schema because the IPC/proxy path in
      // multi-agent mode reaches handleMapTool without schema validation.
      if (a.flows !== undefined && !Array.isArray(a.flows)) {
        throw new Error('browser.map.save: flows must be an array');
      }
      const rawFlows: unknown[] = a.flows ?? [];
      const validatedFlows = rawFlows.map((raw) => {
        if (typeof raw !== 'object' || raw === null) {
          throw new Error('browser.map.save: each flow must be an object');
        }
        const f = raw as SaveFlowArg;
        if (typeof f.name !== 'string' || f.name.trim().length === 0) {
          throw new Error('browser.map.save: each flow requires a non-empty name');
        }
        const validated = validateFlowSteps(f.steps);
        if (!validated.ok) {
          throw new Error(`browser.map.save: flow "${f.name}": ${validated.error}`);
        }
        return { name: f.name, description: f.description ?? null, steps: validated.steps };
      });

      const validatedMechanisms = validateInsights(a.mechanisms, 'mechanism');
      const validatedPitfalls = validateInsights(a.pitfalls, 'pitfall');

      if (typeof a.origin !== 'string' || a.origin.trim().length === 0) {
        throw new Error('browser.map.save: origin is required');
      }
      // The base entry is all-or-nothing: either all four of url_pattern /
      // kind / purpose / payload, or none of them (then the call must carry
      // flows, mechanisms or pitfalls). A half-filled entry is almost
      // certainly a mistake and would store junk.
      const entryFields = ['url_pattern', 'kind', 'purpose', 'payload'] as const;
      const present = entryFields.filter((f) => a[f] !== undefined);
      const hasEntry = present.length > 0;
      if (hasEntry && present.length < entryFields.length) {
        const missing = entryFields.filter((f) => a[f] === undefined);
        throw new Error(
          `browser.map.save: an entry requires url_pattern, kind, purpose and payload together (missing: ${missing.join(', ')})`,
        );
      }
      if (hasEntry && !ENTRY_KINDS.includes(a.kind as EntryKind)) {
        throw new Error(`browser.map.save: kind must be one of ${ENTRY_KINDS.join(' | ')}`);
      }
      if (hasEntry) validatePayloadSemanticKey(a.payload, a.purpose, a.url_pattern);
      if (
        !hasEntry &&
        validatedFlows.length + validatedMechanisms.length + validatedPitfalls.length === 0
      ) {
        throw new Error(
          'browser.map.save: nothing to save — pass an entry (url_pattern, kind, purpose, payload) and/or flows, mechanisms or pitfalls',
        );
      }

      // One transaction for the whole write phase: a failure part-way must
      // not leave an entry saved without the pitfalls that came with it.
      return inTransaction(() => {
        const savedEntry = hasEntry
          ? saveEntry({
              origin: a.origin,
              app_key: a.app_key ?? null,
              title: a.title ?? null,
              url_pattern: a.url_pattern as string,
              kind: a.kind as EntryKind,
              purpose: a.purpose as string,
              payload: a.payload,
              notes: a.notes ?? null,
            })
          : {
              app: upsertApp({
                origin: a.origin,
                app_key: a.app_key ?? null,
                title: a.title ?? null,
              }),
            };

        const extras: { flows?: FlowRow[]; mechanisms?: InsightRow[]; pitfalls?: InsightRow[] } =
          {};
        if (validatedFlows.length > 0) {
          extras.flows = validatedFlows.map(
            (f) =>
              saveFlow({
                origin: a.origin,
                app_key: a.app_key ?? null,
                title: a.title ?? null,
                name: f.name,
                description: f.description,
                steps: f.steps,
              }).flow,
          );
        }
        const saveInsights = (kind: InsightKind, items: ValidatedInsight[]): InsightRow[] =>
          items.map(
            (i) =>
              saveInsight({
                origin: a.origin,
                app_key: a.app_key ?? null,
                title: a.title ?? null,
                kind,
                key: i.key,
                description: i.description,
                symptom: i.symptom,
              }).insight,
          );
        if (validatedMechanisms.length > 0) {
          extras.mechanisms = saveInsights('mechanism', validatedMechanisms);
        }
        if (validatedPitfalls.length > 0) {
          extras.pitfalls = saveInsights('pitfall', validatedPitfalls);
        }
        return Object.keys(extras).length === 0 ? savedEntry : { ...savedEntry, ...extras };
      });
    }
    case 'browser.map.record_use': {
      const a = args as RecordUseArgs;
      return recordUse({ entry_id: a.entry_id, ok: a.ok, notes: a.notes ?? null });
    }
    case 'browser.map.forget': {
      const a = args as ForgetArgs;
      if (a.insight !== undefined) {
        const ins = a.insight;
        if (
          typeof ins !== 'object' ||
          ins === null ||
          typeof ins.app_id !== 'number' ||
          (ins.kind !== 'mechanism' && ins.kind !== 'pitfall') ||
          typeof ins.key !== 'string' ||
          ins.key.trim().length === 0
        ) {
          throw new Error(
            'browser.map.forget: insight must be { app_id: number, kind: "mechanism" | "pitfall", key: string }',
          );
        }
        return forget({
          insight: { app_id: ins.app_id, kind: ins.kind, key: ins.key.trim() },
          reason: a.reason,
        });
      }
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
