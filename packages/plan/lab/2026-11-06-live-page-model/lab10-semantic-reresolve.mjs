// Lab 10: precision of semantic re-resolution (spec v4 §5.6 secondary identity,
// §6.3 S3). When a node is gone after a re-render, can we find "the same"
// element again from its key = role + accessible name + ancestor path, and how
// often do we get it WRONG (which is the blocker-class failure: clicking the
// wrong element) versus UNIQUE versus NO-MATCH?
//
// Method, per scenario: tag every visible interactive element with its key and
// its text; force a re-render that replaces nodes (a list filter); for every
// tagged element whose node is no longer connected, run the candidate
// algorithm against the new DOM:
//   candidates = elements with the same role AND the same name;
//   score      = shared leading segments of the TAG-ONLY path (no sibling
//                index) / max path length, tie-break by the summed absolute
//                sibling-index distance (smaller is better);
//   accept     = a single best candidate (ties refused).
// Ground truth: the re-resolved node is "correct" when its own key (role +
// name + tag path) equals the old key ignoring sibling indices AND its text
// equals the old text; "wrong" otherwise; "no-match" when nothing shares
// role+name; "tie" when two best candidates score the same.
// Also counts how many gone elements had 1 / 2+ same-role+name candidates.
//
// usage: node lab10-semantic-reresolve.mjs ha | react
// Read-only on the house (HA: text filter on /config/entities). Writes
// results/lab10-reresolve-<scenario>.json with machine paths scrubbed.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const HTTP = 'http://127.0.0.1:9222';
const scenario = process.argv[2];
if (scenario !== 'ha' && scenario !== 'react') {
  console.error('usage: lab10-semantic-reresolve.mjs ha | react');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const target = await (await fetch(`${HTTP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
let nextId = 1;
const pending = new Map();
const listeners = [];
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
    return;
  }
  for (const l of listeners) l(m.method, m.params);
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};
const waitLoad = () => new Promise((r) => listeners.push((m) => m === 'Page.loadEventFired' && r()));
await send('Page.enable');
await send('Runtime.enable');

const LIB = `(() => {
  if (window.__lab10) return 'present';
  const SEL = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=textbox], [contenteditable], [tabindex]:not([tabindex="-1"])';
  const norm = (s) => String(s || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const IMPLICIT = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button' };
  const role = (el) => el.getAttribute('role') || (el.localName === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button' }[el.type] || 'textbox') : IMPLICIT[el.localName] || el.localName);
  const labelText = (el) => { const id = el.id; if (id) { const l = (el.getRootNode().querySelector ? el.getRootNode() : document).querySelector('label[for="' + id.replace(/"/g, '\\\\"') + '"]'); if (l) return l.textContent; } const p = el.closest('label'); return p ? p.textContent : ''; };
  const name = (el) => norm(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && [...el.getAttribute('aria-labelledby').split(/\\s+/)].map((i) => (el.getRootNode().getElementById ? el.getRootNode() : document).getElementById(i)?.textContent || '').join(' ')) || labelText(el) || el.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || (/^(button|submit)$/.test(el.type) ? el.value : ''));
  const idx = (el) => { let i = 1, s = el; while ((s = s.previousElementSibling)) if (s.localName === el.localName) i++; return i; };
  const pathOf = (el) => { const tags = [], idxs = []; let n = el, depth = 0; while (n && depth < 8) { if (n.nodeType === 11) { tags.push('#shadow'); idxs.push(0); n = n.host; continue; } if (n.nodeType !== 1) break; tags.push(n.localName); idxs.push(idx(n)); n = n.parentNode; depth++; } return { tags: tags.reverse(), idxs: idxs.reverse() }; };
  const visible = (el) => { const r = el.getClientRects(); return r.length > 0 && r[0].width > 0 && r[0].height > 0; };
  const all = () => { const out = []; const walk = (root) => { for (const el of root.querySelectorAll(SEL)) if (visible(el)) out.push(el); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot); }; walk(document); return out; };
  const keyOf = (el) => { const p = pathOf(el); return { role: role(el), name: name(el), tags: p.tags, idxs: p.idxs, text: norm(el.textContent) }; };
  let tagged = [];
  const api = {
    tag() { tagged = all().map((el) => ({ el, key: keyOf(el) })); return { total: tagged.length, with_name: tagged.filter((t) => t.key.name).length }; },
    reresolve() {
      const live = all().map((el) => ({ el, key: keyOf(el) }));
      const gone = tagged.filter((t) => !t.el.isConnected);
      const kept = tagged.length - gone.length;
      const rows = { unique_correct: 0, unique_wrong: 0, tie: 0, no_match: 0, no_name: 0, candidates_1: 0, candidates_2plus: 0 };
      const samples = { wrong: [], tie: [] };
      for (const t of gone) {
        if (!t.key.name) { rows.no_name++; continue; }
        const cands = live.filter((l) => l.key.role === t.key.role && l.key.name === t.key.name);
        if (cands.length === 0) { rows.no_match++; continue; }
        if (cands.length === 1) rows.candidates_1++; else rows.candidates_2plus++;
        const score = (c) => { const a = t.key.tags, b = c.key.tags; let shared = 0; while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++; const frac = shared / Math.max(a.length, b.length); let dist = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) dist += Math.abs((t.key.idxs[i] || 0) - (c.key.idxs[i] || 0)); return { frac, dist }; };
        const scored = cands.map((c) => ({ c, s: score(c) })).sort((x, y) => y.s.frac - x.s.frac || x.s.dist - y.s.dist);
        const best = scored[0], second = scored[1];
        if (second && second.s.frac === best.s.frac && second.s.dist === best.s.dist) { rows.tie++; if (samples.tie.length < 3) samples.tie.push({ role: t.key.role, name: t.key.name, candidates: cands.length }); continue; }
        const sameTagPath = best.c.key.tags.join('>') === t.key.tags.join('>');
        if (sameTagPath && best.c.key.text === t.key.text) rows.unique_correct++;
        else { rows.unique_wrong++; if (samples.wrong.length < 3) samples.wrong.push({ role: t.key.role, name: t.key.name, old_text: t.key.text, new_text: best.c.key.text, old_path: t.key.tags.join('>'), new_path: best.c.key.tags.join('>') }); }
      }
      // Key uniqueness in the NEW DOM (role+name vs role+name+tag path vs +indices)
      const count = (f) => { const m = new Map(); for (const l of live) { const k = f(l.key); m.set(k, (m.get(k) || 0) + 1); } return [...m.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0); };
      return { live_total: live.length, tagged_total: tagged.length, kept, gone: gone.length, ...rows, samples, dup_role_name: count((k) => k.role + '|' + k.name), dup_role_name_tagpath: count((k) => k.role + '|' + k.name + '|' + k.tags.join('>')), dup_role_name_fullpath: count((k) => k.role + '|' + k.name + '|' + k.tags.map((t, i) => t + ':' + k.idxs[i]).join('>')) };
    },
  };
  window.__lab10 = api;
  return 'installed';
})()`;

const DEEP = `const deepAll = (sel, root = document, out = []) => { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out); return out; };`;
const typeInto = (selector, text) =>
  evaluate(`(() => { ${DEEP} const el = deepAll(${JSON.stringify(selector)}).find((x) => x.getClientRects().length); if (!el) return 'not-found'; el.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); el.dispatchEvent(new Event('change', { bubbles: true, composed: true })); return 'typed'; })()`);
const pressEnter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};

const page = scenario === 'ha' ? 'http://homeassistant.local:8123/config/entities' : 'https://github.com/facebook/react/issues';
const loaded = waitLoad();
await send('Page.navigate', { url: page });
await Promise.race([loaded, sleep(25000)]);
await sleep(3000);
await send('Page.bringToFront');
await evaluate(LIB);

const runs = [];
async function run(label, act) {
  const tagged = await evaluate('window.__lab10.tag()');
  const actResult = await act();
  await sleep(2500);
  const r = await evaluate('window.__lab10.reresolve()');
  const row = { step: label, act_result: actResult, tagged, ...r };
  console.log(JSON.stringify({ step: label, act: actResult, tagged: tagged.total, gone: r.gone, unique_correct: r.unique_correct, unique_wrong: r.unique_wrong, tie: r.tie, no_match: r.no_match, no_name: r.no_name, c1: r.candidates_1, c2plus: r.candidates_2plus, dupRN: r.dup_role_name, dupRNT: r.dup_role_name_tagpath, dupRNF: r.dup_role_name_fullpath }));
  runs.push(row);
}
if (scenario === 'ha') {
  await run('filter "sensor" (rows replaced)', () => typeInto('input[type="search"], input', 'sensor'));
  await run('clear filter (rows restored)', () => typeInto('input[type="search"], input', ''));
  await run('filter "light"', () => typeInto('input[type="search"], input', 'light'));
  await run('filter "li" (superset of light)', () => typeInto('input[type="search"], input', 'li'));
} else {
  await run('filter "hooks" + Enter', async () => { const t = await typeInto('#issues-index-filter-input', 'is:issue state:open hooks'); await pressEnter(); await sleep(3000); return t; });
  await run('filter back to open issues + Enter', async () => { const t = await typeInto('#issues-index-filter-input', 'is:issue state:open'); await pressEnter(); await sleep(3000); return t; });
  await run('filter "suspense" + Enter', async () => { const t = await typeInto('#issues-index-filter-input', 'is:issue state:open suspense'); await pressEnter(); await sleep(3000); return t; });
}

ws.close();
await fetch(`${HTTP}/json/close/${target.id}`).catch(() => {});
mkdirSync(join(LAB_DIR, 'results'), { recursive: true });
const scrub = (s) => s.replaceAll(LAB_DIR.replaceAll('\\', '/'), '<lab-dir>').replaceAll(LAB_DIR, '<lab-dir>');
writeFileSync(join(LAB_DIR, 'results', `lab10-reresolve-${scenario}.json`), scrub(JSON.stringify({ question: 'Precision of semantic re-resolution (role + name hard filter, tag-path similarity, sibling-index tie-break, ties refused) after list re-renders', scenario, page, runs }, null, 2)) + '\n');
console.log(`wrote results/lab10-reresolve-${scenario}.json`);
