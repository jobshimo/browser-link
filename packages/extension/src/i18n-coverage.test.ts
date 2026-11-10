/**
 * Keeps the dictionaries and the interface in step (no dead or missing text):
 * - every visible text and labelling attribute in the extension's HTML is bound
 *   to a key (or explicitly opted out with the standard `translate="no"`);
 * - every bound key exists and holds a plain string;
 * - every dictionary key is used by some HTML file or script;
 * - the window scripts carry no hard-coded English copy.
 * Each failure names the file and the key or text at fault.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { dictionaryKeys, isStaticKey } from './i18n.js';

// A path, not a URL: under jsdom the global URL is not the one node:fs accepts.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML_FILES = ['popup.html', 'activity.html', 'admin.html'];
const WINDOW_SCRIPTS = ['popup.ts', 'activity.ts', 'admin.ts', 'admin-view.ts'];
const LABEL_ATTRIBUTES = ['title', 'placeholder', 'aria-label'];
const HAS_LETTER = /\p{L}/u;

const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

function parse(file: string): Document {
  return new DOMParser().parseFromString(read(file), 'text/html');
}

/** Opted out of translation: proper names such as the product name and the
 * language names in the selector. */
function isOptedOut(node: Element | null): boolean {
  return node?.closest('[translate="no"]') != null;
}

function isCode(node: Element | null): boolean {
  return node?.closest('script, style, svg') != null;
}

function unboundTexts(doc: Document): string[] {
  const found: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? '').trim();
        const parent = child.parentElement;
        if (text === '' || !HAS_LETTER.test(text) || isCode(parent) || isOptedOut(parent)) continue;
        if (!parent?.hasAttribute('data-i18n')) found.push(text);
      } else {
        walk(child);
      }
    }
  };
  walk(doc.head.querySelector('title') ?? doc.createElement('title'));
  walk(doc.body);
  return found;
}

function unboundAttributes(doc: Document): string[] {
  const found: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (isCode(el) || isOptedOut(el)) continue;
    for (const name of LABEL_ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value === null || !HAS_LETTER.test(value)) continue;
      if (!el.hasAttribute(`data-i18n-${name}`)) found.push(`${name}="${value}"`);
    }
  }
  return found;
}

function boundKeys(doc: Document): string[] {
  const keys: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of ['data-i18n', ...LABEL_ATTRIBUTES.map((a) => `data-i18n-${a}`)]) {
      const key = el.getAttribute(attribute);
      if (key !== null) keys.push(key);
    }
  }
  return keys;
}

function sourceFiles(): string[] {
  return readdirSync(join(ROOT, 'src'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'i18n.ts')
    .map((f) => read(`src/${f}`));
}

/** Comments out, so a key or a sentence mentioned in prose counts for nothing. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A window script as the copy checks read it: no comments, no `${…}`
 * interpolations (values, not copy) and no product name. */
function copyOf(file: string): string {
  return stripComments(read(`src/${file}`))
    .replace(/\$\{[^}]*\}/g, '')
    .replaceAll('browser-link', '');
}

describe.each(HTML_FILES)('%s', (file) => {
  const doc = parse(file);

  test('every visible text is bound to a dictionary key', () => {
    expect(unboundTexts(doc), `${file}: text without data-i18n`).toEqual([]);
  });

  test('every title, placeholder and aria-label is bound to a dictionary key', () => {
    expect(unboundAttributes(doc), `${file}: attribute without data-i18n-*`).toEqual([]);
  });

  test('every bound key exists and holds a plain string', () => {
    const missing = boundKeys(doc).filter((key) => !isStaticKey(key));
    expect(missing, `${file}: unknown keys`).toEqual([]);
  });

  test('a data-i18n element holds only text, so rendering it cannot wipe markup', () => {
    const nested = Array.from(doc.querySelectorAll('[data-i18n]'))
      .filter((el) => el.children.length > 0)
      .map((el) => el.getAttribute('data-i18n'));
    expect(nested, `${file}: data-i18n on elements with children`).toEqual([]);
  });

  test('has the EN | ES selector as the last element of its header', () => {
    const header = doc.querySelector('header');
    const last = header?.lastElementChild;
    expect(last?.classList.contains('lang-switch'), `${file}: header ends with .lang-switch`).toBe(
      true,
    );
    const langs = Array.from(last?.querySelectorAll('button[data-lang]') ?? []).map((b) =>
      b.getAttribute('data-lang'),
    );
    expect(langs).toEqual(['en', 'es']);
  });
});

describe('dictionary usage', () => {
  test('every key is used by an HTML file or a script', () => {
    const html = HTML_FILES.flatMap((f) => boundKeys(parse(f)));
    const scripts = sourceFiles().map(stripComments).join('\n');
    const unused = dictionaryKeys().filter(
      (key) => !html.includes(key) && !new RegExp(`\\.${key}\\b`).test(scripts),
    );
    expect(unused, 'keys used nowhere').toEqual([]);
  });
});

describe.each(WINDOW_SCRIPTS)('%s', (file) => {
  test('sets no hard-coded copy on the page', () => {
    const code = copyOf(file);
    // A literal with letters written straight into the page: text, a label
    // attribute, a confirm dialog. Interface copy goes through the dictionary.
    const literalSinks =
      /(?:textContent|innerText|title|placeholder)\s*=\s*(['"`])[^'"`]*\p{L}[^'"`]*\1|setAttribute\(\s*'(?:aria-label|title|placeholder)'\s*,\s*(['"`])[^'"`]*\p{L}|confirm\(\s*(['"`])[^'"`]*\p{L}/gu;
    expect(code.match(literalSinks) ?? [], `${file}: literal copy`).toEqual([]);
  });

  test('builds no English sentence outside the dictionary', () => {
    const code = copyOf(file)
      .split('\n')
      .filter((line) => !/throw new Error|console\.|import /.test(line))
      .join('\n');
    // Two or more words starting with a capital, the shape of a UI sentence
    // ("Connect this tab", "No activity yet"). Identifiers never match it.
    const sentences = code.match(/(['"`])[A-Z][a-z]+(?: [a-z…]+)+[^'"`]*\1/g) ?? [];
    expect(sentences, `${file}: English copy`).toEqual([]);
  });
});
