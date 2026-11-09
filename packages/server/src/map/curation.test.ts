import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from './db.js';
import { resolveLearnerApp, listFlows, listInsights } from './queries.js';
import { clearTypedValues, getReader, upsertReader, type ReaderRow } from './readers.js';
import { recordOutcome } from './learning.js';
import {
  WRAP_UP_MAX_BYTES,
  applyCuration,
  fillPlaceholders,
  isCurationBody,
  parseCurationBody,
  pitfallCandidates,
  placeholdersOf,
  validateCuration,
  wrapUpReport,
  type CurationContext,
  type PitfallCandidate,
} from './curation.js';
import type { SessionFlowRecord, AgentSession } from './session.js';

function reader(overrides: Partial<ReaderRow> = {}): ReaderRow {
  return {
    id: 1,
    app_id: 7,
    hash: 'h',
    expression: 'document.title',
    kind: 'reader',
    name: null,
    ok_n: 2,
    fail_n: 0,
    last_ok_at: '2026-11-09T10:00:00.000Z',
    last_fail_at: null,
    last_ok_build: null,
    result_bytes_avg: 20,
    flags: [],
    status: 'pending',
    created_at: '2026-11-09T09:00:00.000Z',
    template: null,
    ...overrides,
  };
}

function flow(overrides: Partial<SessionFlowRecord> = {}): SessionFlowRecord {
  return {
    session_index: 0,
    origin: 'https://app.test',
    name: null,
    saved_name: null,
    steps: [{ click: { selector: '.next' } }],
    stopped_by: null,
    ok: true,
    kept: null,
    ...overrides,
  };
}

const CANDIDATE: PitfallCandidate = {
  id: 'o5',
  app_id: 7,
  action: 'click',
  target: '.next',
  reason: 'retargeted',
  n: 3,
  build: '3f9a',
  key: 'learned-click-next',
  sentence: 'click on `.next` was retargeted 3 times on build 3f9a',
};

function ctx(overrides: Partial<CurationContext> = {}): CurationContext {
  return {
    readers: new Map([[1, reader()]]),
    namesInUse: new Map(),
    flows: [flow()],
    candidates: new Map([[CANDIDATE.id, CANDIDATE]]),
    typedValues: [],
    ...overrides,
  };
}

function keepOne(
  r: ReaderRow,
  item: { name: string; template?: string },
  extra: Partial<CurationContext> = {},
) {
  return validateCuration(
    { readers: { keep: [{ id: r.id, ...item }] } },
    ctx({ readers: new Map([[r.id, r]]), ...extra }),
  );
}

describe('parseCurationBody', () => {
  test('isCurationBody: no body or an empty one is step 1', () => {
    expect(isCurationBody(undefined)).toBe(false);
    expect(isCurationBody({})).toBe(false);
    expect(isCurationBody({ readers: {} })).toBe(true);
  });

  test('a malformed body throws naming the field', () => {
    expect(() => parseCurationBody({ readers: { keep: [{ id: 'x', name: 'a' }] } })).toThrow(
      /readers\.keep\[0\]\.id/,
    );
    expect(() => parseCurationBody({ feedback: [{ tool: 'x', observed: 'y' }] })).toThrow(
      /feedback\[0\]\.expected/,
    );
    expect(() =>
      parseCurationBody({
        feedback: [{ tool: 'x', observed: 'y'.repeat(501), expected: 'z' }],
      }),
    ).toThrow(/500/);
    expect(() => parseCurationBody({ other: 1 })).toThrow(/other/);
  });

  test('flows.keep accepts id or session_index', () => {
    const body = parseCurationBody({ flows: { keep: [{ id: 2, name: 'a' }] } });
    expect(body.flows?.keep?.[0].session_index).toBe(2);
  });
});

describe('validateCuration — the eight rules', () => {
  test('a valid keep is accepted', () => {
    const plan = keepOne(reader(), { name: 'invoice-total' });
    expect(plan.rejected).toEqual([]);
    expect(plan.keepReaders).toEqual([{ id: 1, app_id: 7, name: 'invoice-total', template: null }]);
  });

  test('R1: ok_n = 0 is rejected', () => {
    const plan = keepOne(reader({ ok_n: 0, last_ok_at: null }), { name: 'invoice-total' });
    expect(plan.rejected).toEqual([expect.objectContaining({ item: 'reader #1', rule: 1 })]);
  });

  test('R1: last outcome failed is rejected', () => {
    const plan = keepOne(reader({ last_fail_at: '2026-11-09T11:00:00.000Z', fail_n: 1 }), {
      name: 'invoice-total',
    });
    expect(plan.rejected[0].rule).toBe(1);
  });

  test('R1: an unknown reader id is rejected', () => {
    const plan = validateCuration({ readers: { keep: [{ id: 99, name: 'x-y' }] } }, ctx());
    expect(plan.rejected[0]).toMatchObject({ item: 'reader #99', rule: 1 });
  });

  test('R2: literal_data without a template is rejected', () => {
    const r = reader({ expression: 'find("Juan Perez")', flags: ['literal_data'] });
    expect(keepOne(r, { name: 'client-row' }).rejected[0].rule).toBe(2);
  });

  test('R2: a template that keeps a flagged literal is rejected', () => {
    const r = reader({ expression: 'find("Juan Perez", "x")', flags: ['literal_data'] });
    const plan = keepOne(r, { name: 'client-row', template: 'find("Juan Perez", "<X>")' });
    expect(plan.rejected[0].rule).toBe(2);
  });

  test('R2: a template whose code differs outside string literals is rejected', () => {
    const r = reader({ expression: 'find("Juan Perez")', flags: ['literal_data'] });
    const plan = keepOne(r, { name: 'client-row', template: 'other("<NAME>")' });
    expect(plan.rejected[0].rule).toBe(2);
  });

  test('R2: a template with placeholders replacing every flagged literal is accepted', () => {
    const r = reader({ expression: 'find("Juan Perez")', flags: ['literal_data'] });
    const plan = keepOne(r, { name: 'client-row', template: 'find("<NAME>")' });
    expect(plan.rejected).toEqual([]);
    expect(plan.keepReaders[0].template).toBe('find("<NAME>")');
  });

  test('R3: secret_shape flag, secret-looking code and mutations are rejected', () => {
    expect(keepOne(reader({ flags: ['secret_shape'] }), { name: 'a-b' }).rejected[0].rule).toBe(3);
    expect(
      keepOne(reader({ expression: 'document.cookie' }), { name: 'a-b' }).rejected[0].rule,
    ).toBe(3);
    expect(keepOne(reader({ kind: 'mutation' }), { name: 'a-b' }).rejected[0].rule).toBe(3);
  });

  test('R3: a template that turns the reader into a mutation is rejected', () => {
    const r = reader({ expression: 'q("Juan Perez").id', flags: ['literal_data'] });
    const plan = keepOne(r, { name: 'a-b', template: 'q("<A>").id', ...{} });
    expect(plan.rejected).toEqual([]);
    const secret = keepOne(r, { name: 'a-b', template: 'q("<A> token").id' });
    expect(secret.rejected[0].rule).toBe(3);
  });

  test.each([
    ['Invoice', 'not kebab'],
    ['get-total', 'verb'],
    ['run', 'verb'],
    ['a'.repeat(41), 'longer'],
    ['a--b', 'not kebab'],
  ])('R4: name %s is rejected (%s)', (name, why) => {
    const plan = keepOne(reader(), { name });
    expect(plan.rejected[0].rule).toBe(4);
    expect(plan.rejected[0].reason).toMatch(new RegExp(why));
  });

  test('R4: words that only start like a verb are fine; a name already kept on the app is not', () => {
    expect(keepOne(reader(), { name: 'download-links' }).rejected).toEqual([]);
    const plan = keepOne(
      reader(),
      { name: 'invoice-total' },
      { namesInUse: new Map([[7, new Set(['invoice-total'])]]) },
    );
    expect(plan.rejected[0].rule).toBe(4);
  });

  test('R6: only server candidates can be confirmed; drop is always accepted', () => {
    const plan = validateCuration(
      { pitfalls: { confirm: ['o5', 'free text'], drop: ['whatever'] } },
      ctx(),
    );
    expect(plan.confirmPitfalls.map((c) => c.id)).toEqual(['o5']);
    expect(plan.rejected).toEqual([
      expect.objectContaining({ item: 'pitfall free text', rule: 6 }),
    ]);
    expect(plan.dropPitfalls).toEqual(['whatever']);
  });

  test('R6: a candidate sentence over 200 chars is rejected', () => {
    const long = { ...CANDIDATE, sentence: 'x'.repeat(201) };
    const plan = validateCuration(
      { pitfalls: { confirm: ['o5'] } },
      ctx({ candidates: new Map([['o5', long]]) }),
    );
    expect(plan.rejected[0].rule).toBe(6);
  });

  test('R7: a name, template, pitfall, flow or feedback holding a typed value is rejected', () => {
    const typed = { typedValues: ['acme'] };
    expect(keepOne(reader(), { name: 'acme-total' }, typed).rejected[0].rule).toBe(7);
    const r = reader({ expression: 'find("Juan Perez")', flags: ['literal_data'] });
    expect(keepOne(r, { name: 'a-b', template: 'find("acme <X>")' }, typed).rejected[0].rule).toBe(
      7,
    );
    const p = validateCuration({ pitfalls: { confirm: ['o5'] } }, ctx({ typedValues: ['.next'] }));
    expect(p.rejected[0].rule).toBe(7);
    const f = validateCuration(
      { flows: { keep: [{ session_index: 0, name: 'search' }] } },
      ctx({ typedValues: ['shrek'], flows: [flow({ steps: [{ type: { text: 'shrek' } }] })] }),
    );
    expect(f.rejected[0].rule).toBe(7);
    const fb = validateCuration(
      { feedback: [{ tool: 'browser.find', observed: 'acme twice', expected: 'one' }] },
      ctx(typed),
    );
    expect(fb.rejected[0].rule).toBe(7);
    expect(fb.feedback).toEqual([]);
  });

  test('R8: drop always wins, even over a keep of the same id and for unknown ids', () => {
    const plan = validateCuration(
      { readers: { keep: [{ id: 1, name: 'a-b' }], drop: [1, 404] } },
      ctx(),
    );
    expect(plan.dropReaders).toEqual([1, 404]);
    expect(plan.keepReaders).toEqual([]);
    expect(plan.rejected[0]).toMatchObject({ item: 'reader #1', rule: 8 });
  });

  test('R5 is informational: a one-off with a name is kept', () => {
    expect(keepOne(reader({ ok_n: 1 }), { name: 'page-heading' }).rejected).toEqual([]);
  });

  test('flows: a failed run or an unknown index is rejected with R1; steps are validated', () => {
    const failed = validateCuration(
      { flows: { keep: [{ session_index: 0, name: 'search' }] } },
      ctx({ flows: [flow({ ok: false, stopped_by: 'timeout' })] }),
    );
    expect(failed.rejected[0].rule).toBe(1);
    const unknown = validateCuration({ flows: { keep: [{ session_index: 9, name: 'x' }] } }, ctx());
    expect(unknown.rejected[0].rule).toBe(1);
    const invalid = validateCuration(
      { flows: { keep: [{ session_index: 0, name: 'search' }] } },
      ctx({ validateSteps: () => 'bad step' }),
    );
    expect(invalid.rejected[0]).toMatchObject({
      rule: 1,
      reason: expect.stringMatching(/bad step/),
    });
    const ok = validateCuration({ flows: { keep: [{ session_index: 0, name: 'search' }] } }, ctx());
    expect(ok.keepFlows).toHaveLength(1);
  });

  test('valid feedback passes through', () => {
    const fb = validateCuration(
      { feedback: [{ tool: 'browser.find', observed: 'two shapes', expected: 'one' }] },
      ctx(),
    );
    expect(fb.feedback).toEqual([
      { tool: 'browser.find', observed: 'two shapes', expected: 'one' },
    ]);
  });
});

describe('placeholders', () => {
  test('placeholdersOf lists distinct tokens', () => {
    expect(placeholdersOf('a "<X>" "<Y_2>" "<X>" <lower>')).toEqual(['X', 'Y_2']);
  });

  test('fillPlaceholders escapes values for a string literal and refuses a missing one', () => {
    expect(fillPlaceholders('q("<Q>")', { Q: `a"b'c\\` }, 'js')).toBe(`q("a\\"b\\'c\\\\")`);
    expect(() => fillPlaceholders('q("<Q>", "<R>")', { Q: 'x' }, 'js')).toThrow(/<R>/);
    expect(fillPlaceholders('<Q> <Q>', { Q: 'x"' }, 'text')).toBe('x" x"');
  });
});

describe('wrap_up against the map DB', () => {
  let dataDir: string;
  const ORIGIN = 'https://app.test';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-curation-test-'));
    process.env.BROWSER_LINK_DATA_DIR = dataDir;
    clearTypedValues();
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
    delete process.env.BROWSER_LINK_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function session(overrides: Partial<AgentSession> = {}): AgentSession {
    return {
      startedAt: '2000-01-01T00:00:00.000Z',
      firstCallDone: true,
      pendingWrapUp: 1,
      origins: new Set([ORIGIN]),
      typedValues: [],
      flows: [],
      nextFlowIndex: 0,
      ...overrides,
    };
  }

  function seed(): { appId: number; readerId: number } {
    const db = getDb();
    const app = resolveLearnerApp(db, ORIGIN);
    db.prepare(
      `INSERT INTO app_builds (app_id, fingerprint, first_seen_at, last_seen_at)
       VALUES (?, '3f9a', 'a', 'z')`,
    ).run(app.id);
    const row = upsertReader(db, { appId: app.id, expression: 'document.title', ok: true })!;
    for (let i = 0; i < 3; i += 1) {
      recordOutcome(db, {
        origin: ORIGIN,
        pathname: '/list',
        target: '.next',
        target_kind: 'selector',
        action: 'click',
        outcome: { ok: false, reason: 'retargeted' },
        build: '3f9a',
      });
    }
    return { appId: app.id, readerId: row.id };
  }

  test('step 1 lists pending readers, flows, selectors, friction and template pitfall candidates', () => {
    const { readerId } = seed();
    const report = wrapUpReport(getDb(), {
      origins: [ORIGIN, 'https://unknown.test'],
      session: session({
        flows: [flow({ origin: ORIGIN, name: 'go-next', steps: [{ click: { selector: '.n' } }] })],
      }),
    });
    expect(report.step).toBe(1);
    expect(report.apps).toHaveLength(1);
    const app = report.apps[0];
    expect(app.origin).toBe(ORIGIN);
    expect(app.build).toBe('3f9a');
    expect(app.readers).toEqual([
      expect.objectContaining({
        id: readerId,
        expression: 'document.title',
        kind: 'reader',
        ok_n: 1,
      }),
    ]);
    expect(app.flows_run).toEqual([
      {
        session_index: 0,
        name: 'go-next',
        saved_name: null,
        steps: 1,
        stopped_by: null,
        ok: true,
      },
    ]);
    expect(app.selectors).toEqual([
      expect.objectContaining({
        action: 'click',
        target: '.next',
        fail_n: 3,
        last_reason: 'retargeted',
      }),
    ]);
    expect(app.friction).toEqual({ retargeted: 1 });
    expect(app.pitfall_candidates).toEqual([
      expect.objectContaining({
        sentence: 'click on `.next` was retargeted 3 times on build 3f9a',
      }),
    ]);
    expect(app.feedback_candidates).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(WRAP_UP_MAX_BYTES);
  });

  test('step 1 stays under 2 KB and says how much it left out', () => {
    const db = getDb();
    const app = resolveLearnerApp(db, ORIGIN);
    for (let i = 0; i < 40; i += 1) {
      upsertReader(db, {
        appId: app.id,
        expression: `document.querySelectorAll('.row${i}').length`,
        ok: true,
      });
    }
    const report = wrapUpReport(db, { origins: [ORIGIN], session: session() });
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(WRAP_UP_MAX_BYTES);
    expect(report.omitted).toBeGreaterThan(0);
  });

  test('expressions are truncated to 160 characters', () => {
    const db = getDb();
    const app = resolveLearnerApp(db, ORIGIN);
    upsertReader(db, {
      appId: app.id,
      expression: `(() => { return ${'1+'.repeat(150)}1; })()`,
      ok: true,
    });
    const report = wrapUpReport(db, { origins: [ORIGIN], session: session() });
    expect(report.apps[0].readers[0].expression.length).toBe(160);
  });

  test('pitfallCandidates needs >= 2 structural failures on the current build', () => {
    const { appId } = seed();
    expect(pitfallCandidates(getDb(), appId, '3f9a')).toHaveLength(1);
    expect(pitfallCandidates(getDb(), appId, 'other')).toHaveLength(0);
  });

  test('step 2 applies keeps, drops, pitfalls and flows in one transaction', () => {
    const { appId, readerId } = seed();
    const db = getDb();
    const other = upsertReader(db, { appId, expression: 'location.pathname', ok: true })!;
    const candidates = pitfallCandidates(db, appId, '3f9a');
    const flows = [flow({ origin: ORIGIN })];
    const plan = validateCuration(
      {
        readers: { keep: [{ id: readerId, name: 'page-title' }], drop: [other.id] },
        flows: { keep: [{ session_index: 0, name: 'next-page' }] },
        pitfalls: { confirm: [candidates[0].id] },
      },
      ctx({
        readers: new Map([
          [readerId, getReader(db, readerId)!],
          [other.id, getReader(db, other.id)!],
        ]),
        flows,
        candidates: new Map(candidates.map((c) => [c.id, c])),
      }),
    );
    expect(plan.rejected).toEqual([]);
    const applied = applyCuration(db, plan);
    expect(applied.map((a) => a.action).sort()).toEqual(['confirmed', 'dropped', 'kept', 'saved']);
    expect(getReader(db, readerId)).toMatchObject({ status: 'kept', name: 'page-title' });
    expect(getReader(db, other.id)?.status).toBe('dropped');
    expect(listFlows(appId).map((f) => f.name)).toEqual(['next-page']);
    expect(listInsights(appId, 'pitfall')).toEqual([
      expect.objectContaining({
        description: 'click on `.next` was retargeted 3 times on build 3f9a',
      }),
    ]);
    expect(flows[0].kept).toBe('next-page');
  });

  test('a throw midway leaves the DB unchanged', () => {
    const { appId, readerId } = seed();
    const db = getDb();
    const candidates = pitfallCandidates(db, appId, '3f9a');
    const flows = [flow({ origin: ORIGIN })];
    const plan = validateCuration(
      {
        readers: { keep: [{ id: readerId, name: 'page-title' }] },
        flows: { keep: [{ session_index: 0, name: 'next-page' }] },
        pitfalls: { confirm: [candidates[0].id] },
      },
      ctx({
        readers: new Map([[readerId, getReader(db, readerId)!]]),
        flows,
        candidates: new Map(candidates.map((c) => [c.id, c])),
      }),
    );
    let steps = 0;
    expect(() =>
      applyCuration(db, plan, {
        onStep: () => {
          steps += 1;
          if (steps === 2) throw new Error('power cut');
        },
      }),
    ).toThrow(/power cut/);
    expect(getReader(db, readerId)).toMatchObject({ status: 'pending', name: null });
    expect(listFlows(appId)).toEqual([]);
    expect(listInsights(appId, 'pitfall')).toEqual([]);
    expect(flows[0].kept).toBeNull();
  });

  test('a confirmed candidate is not offered again', () => {
    const { appId } = seed();
    const db = getDb();
    const [candidate] = pitfallCandidates(db, appId, '3f9a');
    const plan = validateCuration(
      { pitfalls: { confirm: [candidate.id] } },
      ctx({ candidates: new Map([[candidate.id, candidate]]) }),
    );
    applyCuration(db, plan);
    expect(pitfallCandidates(db, appId, '3f9a')).toEqual([]);
  });
});
