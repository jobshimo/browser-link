// Open the extension's lab.html as a CDP target, ask the worker to run the lab
// on the storm tab, then read chrome.storage.local from the same page.
const EXT = process.argv[2];
const list = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json());
let page = (await list()).find((t) => t.url === `chrome-extension://${EXT}/lab.html`);
if (!page) page = await (await fetch(`http://127.0.0.1:9222/json/new?chrome-extension://${EXT}/lab.html`, { method: 'PUT' })).json();
await new Promise((r) => setTimeout(r, 1500));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data.toString()); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); });
const evalp = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
console.error('[drive] start:', JSON.stringify(await evalp(`chrome.runtime.sendMessage({ run: 'storm.html', prefix: 'file:///C:' })`)));
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const res = await evalp(`chrome.storage.local.get('labResult').then(x => JSON.stringify(x.labResult ?? null))`);
  const obj = JSON.parse(res);
  if (obj && (obj.status === 'done' || obj.status === 'error')) { console.log(JSON.stringify(obj, null, 2)); break; }
  if (i === 29) console.log('timeout, last:', res);
}
ws.close();
