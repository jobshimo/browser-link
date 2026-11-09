// Lab 6: on a Lit app (Home Assistant), how many interactive DOM nodes survive
// an SPA navigation there-and-back? Tags every interactive element with a
// WeakMap id, navigates via the sidebar, comes back, re-walks and counts hits.
// Read-only on the house: only navigation between views.
// usage: node lab6-identity-ha.mjs <HA webSocketDebuggerUrl>
const [, , wsUrl] = process.argv;
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data.toString()); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalp = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };

await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront');
await sleep(500);
await evalp(`(() => {
  const ids = (window.__ids = window.__ids || new WeakMap());
  let next = (window.__next = window.__next || 1);
  const SEL = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [tabindex]';
  const key = (el) => (el.getAttribute('role') || el.tagName.toLowerCase()) + '|' + ((el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40));
  window.__walk = () => {
    const seen = new Map(); // key -> count (semantic identity)
    let total = 0, hits = 0, fresh = 0;
    const walk = (root) => {
      for (const el of root.querySelectorAll(SEL)) {
        total++;
        if (ids.has(el)) hits++; else { ids.set(el, next++); fresh++; }
        const k = key(el); seen.set(k, (seen.get(k) || 0) + 1);
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    window.__next = next;
    return { total, same_node: hits, new_node: fresh, semantic_keys: seen.size, keys: [...seen.keys()] };
  };
  return 'ok';
})()`);
const start = await evalp(`(() => { const r = window.__walk(); return { url: location.href, ...r }; })()`);
const clickHref = async (href) => evalp(`(() => { const walk = (root) => { for (const a of root.querySelectorAll('a[href="${href}"]')) { if (a.getClientRects().length) { a.click(); return true; } } for (const el of root.querySelectorAll('*')) if (el.shadowRoot && walk(el.shadowRoot)) return true; return false; }; return walk(document); })()`);
const went = await clickHref('/config');
await sleep(2500);
const away = await evalp(`(() => { const r = window.__walk(); return { url: location.href, total: r.total, same_node: r.same_node, new_node: r.new_node }; })()`);
await evalp(`history.back(); 'ok'`);
await sleep(2500);
const back = await evalp(`(() => { const r = window.__walk(); return { url: location.href, ...r }; })()`);
const startKeys = new Set(start.keys), backKeys = new Set(back.keys);
const semanticSurvived = [...startKeys].filter((k) => backKeys.has(k)).length;
delete start.keys; delete back.keys;
console.log(JSON.stringify({ start, navigated: went, away, back, semantic: { keys_at_start: startKeys.size, keys_back: backKeys.size, survived: semanticSurvived } }, null, 2));
await evalp(`delete window.__walk; 'ok'`);
ws.close();
