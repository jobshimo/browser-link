// Lab 8: how many interactive DOM nodes survive USER-LEVEL interactions inside
// one view (not just an SPA round trip, which lab 6 measured at 100% kept in
// Lit)? This decides how often S2's `snapshot({since})` will report
// `removed` + `added` instead of `changed`, and how aggressive S3's semantic
// re-resolution must be.
//
// For each step: every interactive element is tagged with a WeakMap id the
// first time it is seen; after the interaction we re-walk (document + open
// shadow roots) and count kept / new / gone, plus how unique two candidate
// semantic keys are (role+name, and role+name+ancestor path with sibling
// index). A full navigation (tagger global gone) is reported as doc_changed.
//
// usage: node lab8-identity-interactions.mjs ha | react
//
// `ha` runs on the owner's Home Assistant (lab profile is logged in): only
// navigation, a text filter and tab switches — nothing that changes a device.
// `react` runs on github.com/facebook/react/issues (a public React app).
// Opens its own tab over raw CDP on the lab Chrome (port 9222), closes it,
// writes an unedited JSON under results/ with machine paths scrubbed.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const HTTP = 'http://127.0.0.1:9222';
const scenario = process.argv[2];
if (scenario !== 'ha' && scenario !== 'react') {
  console.error('usage: lab8-identity-interactions.mjs ha | react');
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

// Tagger + walker, installed per document (re-installed when a full navigation drops it).
const TAGGER = `(() => {
  if (window.__lab8) return 'present';
  const SEL = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=textbox], [contenteditable], [tabindex]:not([tabindex="-1"])';
  const ids = new WeakMap();
  let next = 1;
  let prev = [];
  const norm = (s) => String(s || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
  const name = (el) => norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || el.value);
  const role = (el) => el.getAttribute('role') || el.localName;
  const idx = (el) => { let i = 1, s = el; while ((s = s.previousElementSibling)) if (s.localName === el.localName) i++; return i; };
  const path = (el) => { const parts = []; let n = el; let depth = 0; while (n && depth < 8) { if (n.nodeType === 11) { parts.push('#shadow'); n = n.host; continue; } if (n.nodeType !== 1) break; parts.push(n.localName + ':' + idx(n)); n = n.parentNode; depth++; } return parts.reverse().join('>'); };
  const visible = (el) => { const r = el.getClientRects(); return r.length > 0 && r[0].width > 0 && r[0].height > 0; };
  window.__lab8 = { walk() {
    const cur = [];
    const k1 = new Map(), k2 = new Map();
    let kept = 0, fresh = 0;
    const walk = (root) => {
      for (const el of root.querySelectorAll(SEL)) {
        if (!visible(el)) continue;
        cur.push(el);
        if (ids.has(el)) kept++; else { ids.set(el, next++); fresh++; }
        const a = role(el) + '|' + name(el); k1.set(a, (k1.get(a) || 0) + 1);
        const b = a + '|' + path(el); k2.set(b, (k2.get(b) || 0) + 1);
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    const gone = prev.filter((el) => !el.isConnected).length;
    const detachedButReturned = prev.filter((el) => el.isConnected && !cur.includes(el)).length;
    const dup = (m) => [...m.values()].filter((n) => n > 1).reduce((s, n) => s + n, 0);
    const out = { url: location.href, total: cur.length, kept, new: fresh, gone_from_previous: gone, previous_total: prev.length, hidden_or_filtered_out_from_previous: detachedButReturned, role_name_dup_elements: dup(k1), role_name_path_dup_elements: dup(k2), distinct_role_name: k1.size, distinct_role_name_path: k2.size };
    prev = cur;
    return out;
  } };
  return 'installed';
})()`;

async function step(label, act) {
  const before = await evaluate('typeof window.__lab8');
  const docChanged = before !== 'object';
  if (docChanged) await evaluate(TAGGER);
  const actResult = act ? await act() : null;
  await sleep(1500);
  const after = await evaluate('typeof window.__lab8');
  const docChangedByAction = after !== 'object';
  if (docChangedByAction) await evaluate(TAGGER);
  const walk = await evaluate('window.__lab8.walk()');
  const row = { step: label, act_result: actResult, doc_changed_before: docChanged, doc_changed_by_action: docChangedByAction, ...walk };
  console.log(JSON.stringify(row));
  return row;
}

// Deep helpers used by the interactions (open shadow roots).
const DEEP = `const deepAll = (sel, root = document, out = []) => { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out); return out; };`;
const clickHref = (href) => evaluate(`(() => { ${DEEP} const a = deepAll('a[href="${href}"]').find((x) => x.getClientRects().length); if (!a) return 'not-found'; a.click(); return 'clicked'; })()`);
const typeInto = (selector, text) =>
  evaluate(`(() => { ${DEEP} const el = deepAll(${JSON.stringify(selector)}).find((x) => x.getClientRects().length); if (!el) return 'not-found'; el.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); el.dispatchEvent(new Event('change', { bubbles: true, composed: true })); return 'typed'; })()`);
const pressEnter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};

const rows = [];
let page;
if (scenario === 'ha') {
  page = 'http://homeassistant.local:8123/config/entities';
  const loaded = waitLoad();
  await send('Page.navigate', { url: page });
  await Promise.race([loaded, sleep(20000)]);
  await sleep(3000);
  rows.push(await step('baseline /config/entities'));
  rows.push(await step('idle 1.5 s (no interaction)'));
  rows.push(await step('type "sensor" in the entities search filter', () => typeInto('input[type="search"], input', 'sensor')));
  rows.push(await step('clear the filter', () => typeInto('input[type="search"], input', '')));
  rows.push(await step('switch tab: Devices (a[href="/config/devices/dashboard"])', () => clickHref('/config/devices/dashboard')));
  rows.push(await step('switch tab back: Entities', () => clickHref('/config/entities')));
  rows.push(await step('navigate away: /config/integrations/dashboard', () => clickHref('/config/integrations/dashboard')));
  rows.push(await step('navigate back: /config/entities', () => clickHref('/config/entities')));
  rows.push(await step('type "light" in the filter after the round trip', () => typeInto('input[type="search"], input', 'light')));
} else {
  page = 'https://github.com/facebook/react/issues';
  const loaded = waitLoad();
  await send('Page.navigate', { url: page });
  await Promise.race([loaded, sleep(25000)]);
  await sleep(3000);
  rows.push(await step('baseline react/issues'));
  rows.push(await step('idle 1.5 s (no interaction)'));
  const clickText = (re) => evaluate(`(() => { ${DEEP} const el = deepAll('a[href], button, [role=tab], [role=button]').find((x) => ${re}.test((x.textContent || '').trim()) && x.getClientRects().length); if (!el) return 'not-found'; el.click(); return 'clicked ' + el.localName + ' "' + (x => x.textContent.trim().replace(/\\s+/g, ' ').slice(0, 30))(el) + '"'; })()`);
  rows.push(await step('type "hooks" in the issues filter (#issues-index-filter-input) + Enter', async () => { const t = await typeInto('#issues-index-filter-input', 'is:issue state:open hooks'); await pressEnter(); await sleep(3000); return t; }));
  rows.push(await step('click "Closed"', async () => { const r = await clickText('/^closed\\b/i'); await sleep(2500); return r; }));
  rows.push(await step('click "Open"', async () => { const r = await clickText('/^open\\b/i'); await sleep(2500); return r; }));
  rows.push(await step('clear the filter back to "is:issue state:open" + Enter', async () => { const t = await typeInto('#issues-index-filter-input', 'is:issue state:open'); await pressEnter(); await sleep(3000); return t; }));
}

ws.close();
await fetch(`${HTTP}/json/close/${target.id}`).catch(() => {});
mkdirSync(join(LAB_DIR, 'results'), { recursive: true });
const file = join(LAB_DIR, 'results', `lab8-identity-${scenario}.json`);
const scrub = (s) => s.replaceAll(LAB_DIR.replaceAll('\\', '/'), '<lab-dir>').replaceAll(LAB_DIR, '<lab-dir>');
writeFileSync(file, scrub(JSON.stringify({ question: 'How many interactive nodes survive user-level interactions inside a view; how unique are role+name and role+name+path keys', scenario, page, rows }, null, 2)) + '\n');
console.log(`wrote results/lab8-identity-${scenario}.json`);
