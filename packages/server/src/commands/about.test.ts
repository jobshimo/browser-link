import { afterEach, describe, expect, test, vi } from 'vitest';
import { NOTICE } from '../notice.js';
import { I18N_ABOUT, printAbout } from './about.js';

function captureAbout(language: 'en' | 'es'): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  printAbout(language);
  return lines.join('\n').split('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('printAbout', () => {
  for (const language of ['en', 'es'] as const) {
    test(`${language}: output starts with the notice (title, underline, 3 paragraphs)`, () => {
      const lines = captureAbout(language);
      const n = NOTICE[language];
      expect(lines.slice(0, 2)).toEqual([n.title, '='.repeat(n.title.length)]);
      const out = lines.join('\n');
      let cursor = out.indexOf(n.title);
      for (const p of n.paragraphs) {
        const at = out.indexOf(p);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
      }
      // The notice comes before every existing section.
      const t = I18N_ABOUT[language];
      expect(cursor).toBeLessThan(out.indexOf(t.title));
      expect(cursor).toBeLessThan(out.indexOf(t.privacyTitle));
    });

    test(`${language}: every existing section still prints, in the same order, after the notice`, () => {
      const out = captureAbout(language).join('\n');
      const t = I18N_ABOUT[language];
      const order = [
        t.title,
        t.whatTitle,
        t.howTitle,
        t.bindingTitle,
        t.bridgeToolsTitle,
        t.mapToolsTitle,
        t.privacyTitle,
        t.helpTitle,
        t.authorTitle,
      ];
      let cursor = -1;
      for (const heading of order) {
        const at = out.indexOf(heading, cursor + 1);
        expect(at, heading).toBeGreaterThan(cursor);
        cursor = at;
      }
      expect(out).toContain(t.privacy);
      expect(out).toContain(t.author);
    });
  }
});
