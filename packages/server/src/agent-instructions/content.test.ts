import { describe, expect, test } from 'vitest';
import { VERSION } from '../version.js';
import { beginMarker, block, END_MARKER, findBlockSpan } from './content.js';

/**
 * The agent-instructions block is the user-facing copy that AI agents read
 * to know when to call `browser.*` tools. v0.8.3 rewrites it as an
 * engram-style reflex protocol — imperative trigger list, bilingual
 * trigger phrases as data, explicit SELF-CHECK + NEVER sections.
 *
 * These tests assert structural sections and a few representative phrases.
 * Wording is allowed to evolve without breaking the suite as long as the
 * shape (trigger list + bilingual phrases + self-check + never) survives.
 */

describe('agent-instructions block — reflex protocol shape', () => {
  test('starts with the ALWAYS ACTIVE reflex protocol heading', () => {
    const out = block();
    expect(out).toContain('## browser-link — reflex protocol (ALWAYS ACTIVE)');
  });

  test('TRIGGER LIST section is present', () => {
    const out = block();
    expect(out).toContain('### TRIGGER LIST');
  });

  test('bilingual EN+ES trigger phrases are present as data, not paraphrased', () => {
    const out = block();
    // English representatives.
    expect(out).toContain("the button doesn't work");
    expect(out).toContain('broken layout');
    expect(out).toContain('does X work?');
    expect(out).toContain('open this in the browser');
    // Spanish representatives.
    expect(out).toContain('no anda el botón');
    expect(out).toContain('está roto');
    expect(out).toContain('abrí esto en el navegador');
    expect(out).toContain('¿anda X?');
  });

  test('SELF-CHECK section is present and references browser.list_tabs', () => {
    const out = block();
    expect(out).toContain('### SELF-CHECK');
    expect(out).toContain('browser.list_tabs');
  });

  test('NEVER section enumerates the four forbidden behaviors', () => {
    const out = block();
    expect(out).toContain('### NEVER');
    expect(out).toContain('Speculate about DOM state');
    expect(out).toContain('try clicking X');
    expect(out).toContain('selectors you have not just successfully executed');
    expect(out).toContain('domain data');
  });

  test('multi-agent claim layer is referenced (claim_tab + release_tab)', () => {
    const out = block();
    expect(out).toContain('browser.claim_tab');
    expect(out).toContain('browser.release_tab');
  });

  test('block is fenced with versioned BEGIN + END markers', () => {
    const out = block();
    expect(out).toContain(beginMarker());
    expect(out).toContain(END_MARKER);
    expect(out).toContain(`v${VERSION}`);
  });

  test('findBlockSpan locates the block inside a host file', () => {
    const wrapped = `# user notes\n\n${block()}\n\n## other\n`;
    const span = findBlockSpan(wrapped);
    expect(span).not.toBeNull();
    if (span) {
      expect(span.installedVersion).toBe(VERSION);
    }
  });
});
