import { describe, expect, test } from 'vitest';
import { BROWSER_TOOL_DEFINITIONS } from './browser-definitions.js';
import { MAP_TOOL_DEFINITIONS } from '../map/tools.js';
import { SERVER_INSTRUCTIONS, buildServerInstructions } from './server-instructions.js';

/**
 * The MCP `initialize.instructions` string is generated from the per-tool
 * `doc` blocks. These tests assert:
 *
 *  - every tool with a `doc` block surfaces its name in the generated string,
 *  - every tool with a `doc` block has non-empty `purpose` and `when_to_use`
 *    (structural completeness check — caught here instead of by reviewers),
 *  - the cross-cutting preamble is present (reflex protocol + claim layer
 *    + map preamble),
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

  test('preamble explains what the bridge is and the data dir story', () => {
    const out = buildServerInstructions();
    expect(out).toContain('browser-link bridges Claude Code');
    expect(out).toContain('BROWSER_LINK_DATA_DIR');
    expect(out).toContain('persistent UI map');
  });

  test('reflex protocol section is intact in the preamble', () => {
    const out = buildServerInstructions();
    expect(out).toContain('Reflex protocol');
    expect(out).toContain('browser.list_tabs');
    expect(out).toContain('browser.snapshot');
    expect(out).toContain('Tab not connected');
  });

  test('multi-agent / claim layer section is intact', () => {
    const out = buildServerInstructions();
    expect(out).toContain('claim_tab');
    expect(out).toContain('release_tab');
    expect(out).toContain('IPC session id');
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
