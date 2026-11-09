import { describe, expect, test } from 'vitest';
import { BROWSER_TOOL_DEFINITIONS } from './browser-definitions.js';
import { MAP_TOOL_DEFINITIONS } from '../map/tools.js';
import {
  SERVER_INSTRUCTIONS,
  buildServerInstructions,
  buildStartInstructions,
} from './server-instructions.js';
import type { InstructionsInstaller } from '../agent-instructions/index.js';
import { VERSION } from '../version.js';
import { CORE_HEADING, renderCore } from '../manual/core.js';
import { renderTopic } from '../manual/topics.js';

/**
 * The MCP `initialize.instructions` string is generated from the per-tool
 * `doc` blocks. These tests assert:
 *
 *  - every tool with a `doc` block surfaces its name in the generated string,
 *  - every tool with a `doc` block has non-empty `purpose` and `when_to_use`
 *    (structural completeness check — caught here instead of by reviewers),
 *  - the text is the manual core (the rules the first browser call also
 *    returns), then the tool sections; what left the core lives in topics,
 *  - `SERVER_INSTRUCTIONS` is the live result of `buildServerInstructions`,
 *  - structural sections (Gotchas, Example) only appear when the source
 *    block provides them — so a tool without gotchas never emits an empty
 *    "Gotchas:" header.
 */

const ALL_TOOLS = [...BROWSER_TOOL_DEFINITIONS, ...MAP_TOOL_DEFINITIONS];

describe('buildServerInstructions', () => {
  test('SERVER_INSTRUCTIONS matches the live build (no stale cached string)', () => {
    expect(SERVER_INSTRUCTIONS).toBe(buildServerInstructions());
  });

  test('is the manual core, then the tool sections (hosts that truncate still show the core)', () => {
    const out = buildServerInstructions();
    expect(out.startsWith(`${renderCore({})}\n\n## Tools\n`)).toBe(true);
    expect(out.startsWith(`${CORE_HEADING}\n`)).toBe(true);
  });

  test('a notice becomes the first line', () => {
    const notice = 'Your browser-link instructions block is not-installed.';
    const out = buildServerInstructions({ notice });
    expect(out.split('\n')[0]).toBe(notice);
    expect(out.startsWith(renderCore({ notice }))).toBe(true);
  });

  test('the core starts at list_tabs and its knowledge, and ends at wrap_up and curation', () => {
    const core = renderCore({});
    expect(core).toContain('browser.list_tabs');
    expect(core).toContain('`knowledge`');
    expect(core).toContain('`browser.wrap_up`');
    expect(core).toContain('`pending_wrap_up: n`');
    expect(core).toContain('8. In doubt, drop.');
  });

  test('the core carries hit_element guidance: off target means the click missed', () => {
    const core = renderCore({});
    expect(core).toContain('`ok` is not proof');
    expect(core).toContain('`hit_element` that is not your target means the click missed');
    expect(renderTopic('results')).toContain('the click missed → do not proceed');
  });

  test('the multi-agent claim and cdp-direct gate lines moved to their topics', () => {
    const multi = renderTopic('multi-agent');
    expect(multi).toContain('browser.claim_tab');
    expect(multi).toContain('browser.release_tab');
    expect(multi).toContain('do not spin-retry');
    const cdp = renderTopic('cdp-direct');
    expect(cdp).toContain('browser-link config set cdp-direct.enabled true');
    expect(cdp).toContain('browser-link cdp allow');
    expect(renderTopic('results')).toContain('Tab not connected');
  });

  test('the multi-agent topic keeps the claim layer details', () => {
    const topic = renderTopic('multi-agent');
    expect(topic).toContain('auto-claim');
    expect(topic).toContain('IPC session id');
  });

  test('the map topic keeps the data dir story', () => {
    const topic = renderTopic('map');
    expect(topic).toContain('BROWSER_LINK_DATA_DIR');
    expect(topic).toContain('browser.map.rename_app');
  });

  test('the token-efficiency topic keeps the dedicated-tool patterns', () => {
    const topic = renderTopic('token-efficiency');
    expect(topic).toContain('### Token-efficient patterns');
    expect(topic).toContain('within_selector');
    expect(topic).toContain('only_interactive');
    expect(topic).toContain('pane.scrollTop');
    expect(topic).toContain('latest_id');
    expect(topic).toContain('isTrusted:false');
    expect(topic).toContain('isTrusted:true');
  });

  test('ref over a copied selector is a core rule; snapshot since and ref recovery live in results', () => {
    expect(renderCore({})).toContain('Act on the `ref` from your last `snapshot`/`find`');
    const topic = renderTopic('results');
    expect(topic).toContain(
      'One full `snapshot` per view, then `snapshot({ since: snapshot_id })`',
    );
    expect(topic).toContain('never retry the same ref');
  });

  test('settle: quiet, not effect, with the observer caveats in the topic', () => {
    expect(renderCore({})).toContain('quiet, not effect');
    const topic = renderTopic('token-efficiency');
    expect(topic).toContain('settle_ms');
    expect(topic).toContain('Settle proves QUIET, not EFFECT');
    expect(topic).toContain('settle.changes');
    expect(topic).toContain('changes: null');
    expect(topic).toContain('observer: "<reason>"');
    expect(topic).toMatch(/starts\s+after\s+the\s+quiet\s+window/);
    expect(topic).not.toMatch(/before\s+the\s+observer/);
  });

  test('semantic_key guidance lives in the map topic', () => {
    const topic = renderTopic('map');
    expect(topic).toContain('save that `semantic_key` in the payload next to it,');
    expect(topic).toContain('Never save a key for an `ambiguous` entry.');
  });

  test('browser.find appears as a documented tool section in the rendered instructions', () => {
    const out = buildServerInstructions();
    expect(out).toContain('### browser.find');
  });

  test('every tool with a doc block surfaces its name as a section header', () => {
    const out = buildServerInstructions();
    for (const def of ALL_TOOLS) {
      if (def.doc) {
        expect(out).toContain(`### ${def.name}`);
      }
    }
  });

  test('every tool with a doc block has a non-empty purpose and at least one when_to_use trigger', () => {
    for (const def of ALL_TOOLS) {
      if (!def.doc) continue;
      expect(def.doc.purpose.length).toBeGreaterThan(0);
      expect(def.doc.when_to_use.length).toBeGreaterThan(0);
      for (const trigger of def.doc.when_to_use) {
        expect(trigger.length).toBeGreaterThan(0);
      }
    }
  });

  test('no information loss vs. the previous SERVER_INSTRUCTIONS — key invariants from the v0.8.2 string are present', () => {
    // Spot-check the load-bearing phrases the v0.8.2 SERVER_INSTRUCTIONS
    // string asserted. If a future refactor drops one of these, the test
    // catches it before users see degraded guidance.
    const out = buildServerInstructions();
    expect(out).toContain('source of truth');
    expect(out).toContain('UI structure only');
    // Phrased "NEVER save selectors …" in v0.8.3 (was "Never save selectors").
    expect(out).toMatch(/never save selectors/i);
    expect(out).toContain('domain data');
    expect(out).toContain('selector');
    expect(out).toContain('flow');
    expect(out).toContain('gotcha');
    // Specific tools that anchor the protocol.
    expect(out).toContain('browser.map.recall');
    expect(out).toContain('browser.map.save');
    expect(out).toContain('browser.events');
  });

  test('Gotchas section only appears when the tool provides gotchas', () => {
    // Pick a tool without gotchas if there is one, and assert no empty
    // "Gotchas:" header for it.
    const withoutGotchas = ALL_TOOLS.find(
      (d) => d.doc && (!d.doc.gotchas || d.doc.gotchas.length === 0),
    );
    if (!withoutGotchas) {
      // All tools currently have gotchas — the test is informational then.
      return;
    }
    const out = buildServerInstructions();
    // Crude but robust: locate the section, check it does not include "Gotchas:".
    const header = `### ${withoutGotchas.name}\n`;
    const start = out.indexOf(header);
    expect(start).toBeGreaterThanOrEqual(0);
    // Section ends at the next "### " header or end of string.
    const nextStart = out.indexOf('### ', start + header.length);
    const section = out.slice(start, nextStart === -1 ? out.length : nextStart);
    expect(section).not.toContain('**Gotchas:**');
  });

  test('Example fence is well-formed when present', () => {
    const out = buildServerInstructions();
    const withExample = ALL_TOOLS.filter(
      (d) => d.doc?.example !== undefined && d.doc.example !== '',
    );
    for (const def of withExample) {
      // The example block opens with ``` and the example body, then closes with ```.
      expect(out).toContain(`**Example:**\n\`\`\`\n${def.doc!.example!}\n\`\`\``);
    }
  });
});

describe('start-time instructions (outdated-block notice)', () => {
  const installer = (kind: string, version?: string) =>
    ({
      id: 'claude',
      displayName: 'Claude Code',
      detect: () => ({ filePath: 'x', state: { kind, version } }),
    }) as unknown as InstructionsInstaller;

  test('with autoRefresh off, an installed-outdated block puts the notice first', () => {
    const { text, statuses } = buildStartInstructions([installer('installed-outdated', '0.1.0')], {
      autoRefresh: false,
    });
    expect(statuses).toHaveLength(1);
    expect(text.split('\n')[0]).toMatch(
      /^Your browser-link instructions block is installed-outdated \(installed v0\.1\.0, server v[^)]+\): run `browser-link instructions install` and restart the client\.$/,
    );
    expect(text.split('\n')[2]).toBe(CORE_HEADING);
  });

  test('by default an installed-outdated block is refreshed and the update notice comes first', () => {
    let state: { kind: string; version?: string } = {
      kind: 'installed-outdated',
      version: '0.1.0',
    };
    let installs = 0;
    const refreshable = {
      id: 'claude',
      displayName: 'Claude Code',
      detect: () => ({ filePath: 'x', state }),
      install: () => {
        installs += 1;
        state = { kind: 'installed', version: VERSION };
        return 'Claude Code: refreshed.';
      },
    } as unknown as InstructionsInstaller;
    const { text, statuses, refreshed, failed } = buildStartInstructions([refreshable]);
    expect(installs).toBe(1);
    expect(statuses[0]!.state.kind).toBe('installed');
    expect(refreshed).toHaveLength(1);
    expect(failed).toEqual([]);
    expect(text.split('\n')[0]).toBe(
      `Your browser-link instructions block was updated to v${VERSION} for Claude Code: restart the client to load it.`,
    );
    expect(text.split('\n')[2]).toBe(CORE_HEADING);
  });

  test('an up-to-date block leaves the text identical to SERVER_INSTRUCTIONS', () => {
    const { text } = buildStartInstructions([installer('installed', VERSION)]);
    expect(text).toBe(SERVER_INSTRUCTIONS);
  });
});
