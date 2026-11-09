// Lab 4: current settle (observer installed AFTER dispatch, quiet 150 ms,
// timeout 2000 ms) vs a persistent agent that attributes mutations to an
// action window. Also measures the agent's own main-thread cost.
// usage: node lab4-settle-exact.mjs <webSocketDebuggerUrl>
const [, , wsUrl] = process.argv;
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
let id = 0; const pending = new Map(); const handlers = [];
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data.toString()); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; } for (const h of handlers) h(m.method, m.params); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalp = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };

await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront');
await evalp(`location.reload(); 'ok'`).catch(() => {});
await sleep(1500);

async function clickButton() {
  const box = await evalp(`(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
}

// --- A: current browser-link settle, verbatim semantics (builders.ts buildSettleJs) ---
const CURRENT_SETTLE = `(() => {
  const opts = { settleMs: 150, timeoutMs: 2000 };
  const state = { mutationCount: 0, lastMutationAt: Date.now() };
  const observer = new MutationObserver((m) => { state.mutationCount += m.length; state.lastMutationAt = Date.now(); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const start = Date.now();
  return new Promise((resolve) => {
    function finish(settled) { observer.disconnect(); resolve({ settled, duration_ms: Date.now() - start, mutation_count: state.mutationCount }); }
    (function check() { const now = Date.now(); const quietFor = now - state.lastMutationAt; if (quietFor >= opts.settleMs) return finish(true); if (now - start >= opts.timeoutMs) return finish(false); setTimeout(check, Math.min(opts.settleMs - quietFor, 50)); })();
  });
})()`;
await clickButton();
const current = await evalp(CURRENT_SETTLE);
const stateAfterA = await evalp(`({ out: document.getElementById('out').textContent, items: document.querySelectorAll('li').length, done: document.getElementById('out').getAttribute('data-done') })`);
await sleep(1200);

// --- B: persistent agent with action windows ---
await evalp(`location.reload(); 'ok'`).catch(() => {});
await sleep(1500);
await evalp(`(() => {
  const blm = (window.__blm = { records: [], selfMs: 0, markAt: 0 });
  const opts = { subtree: true, childList: true, attributes: true, characterData: true };
  const desc = (n) => n.nodeType === 3 ? '#text<' + desc(n.parentNode) + '>' : (n.tagName || n.nodeName).toLowerCase() + (n.id ? '#' + n.id : '');
  new MutationObserver((recs) => {
    const t0 = performance.now();
    for (const r of recs) blm.records.push({ at: performance.now() - blm.markAt, type: r.type, target: desc(r.target), attr: r.attributeName || undefined, added: r.addedNodes.length || undefined });
    blm.selfMs += performance.now() - t0;
  }).observe(document, opts);
  blm.mark = () => { blm.markAt = performance.now(); blm.records = []; };
  return 'agent ready';
})()`);
await evalp(`window.__blm.mark(); 'marked'`);
await clickButton();
// Poll until quiet for 150 ms or 2000 ms total, like settle does, but reading the agent.
const t0 = Date.now();
let quietSince = Date.now(), lastCount = 0;
while (Date.now() - t0 < 2000) {
  await sleep(50);
  const n = await evalp(`window.__blm.records.length`);
  if (n !== lastCount) { lastCount = n; quietSince = Date.now(); }
  else if (Date.now() - quietSince >= 150) break;
}
const agentAtQuiet = await evalp(`JSON.stringify(window.__blm.records)`);
await sleep(1200);
const agentAfter = await evalp(`JSON.stringify(window.__blm.records)`);

console.log(JSON.stringify({
  A_current_settle: { result: current, page_state_right_after: stateAfterA, note: 'observer installed after dispatch' },
  B_agent_at_quiet: { quiet_after_ms: Date.now() - t0, records: JSON.parse(agentAtQuiet) },
  B_agent_1200ms_later: JSON.parse(agentAfter),
}, null, 2));
ws.close();
