// Lab 2: do CDP DOM events report mutations INSIDE shadow roots (open, closed,
// and roots created after getDocument)? Controlled synthetic mutations only;
// nothing on the page is clicked. Every mutation is undone.
//
// usage: node lab2-shadow-coverage.mjs <webSocketDebuggerUrl>

const [, , wsUrl] = process.argv;
if (!wsUrl) { console.error('missing webSocketDebuggerUrl'); process.exit(2); }

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
let onEvent = () => {};
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (msg.id !== undefined) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (!p) return;
    msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    return;
  }
  onEvent(msg.method, msg.params);
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nodes = new Map();
function indexNode(n, parentId, depth, shadowDepth) {
  nodes.set(n.nodeId, { parent: parentId, depth, shadowDepth, name: n.nodeName, backend: n.backendNodeId, shadowRootType: n.shadowRootType });
  for (const c of n.children ?? []) indexNode(c, n.nodeId, depth + 1, shadowDepth);
  for (const sr of n.shadowRoots ?? []) indexNode(sr, n.nodeId, depth + 1, shadowDepth + 1);
  if (n.contentDocument) indexNode(n.contentDocument, n.nodeId, depth + 1, shadowDepth);
}

await send('Runtime.enable');
await send('DOM.enable');
const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
indexNode(doc.root, null, 0, 0);
const countType = (t) => [...nodes.values()].filter((n) => n.shadowRootType === t).length;

let bucket = [];
onEvent = (method, params) => {
  if (!method.startsWith('DOM.')) return;
  const ids = [params.nodeId, params.parentNodeId, params.hostId, params.parentId].filter((x) => x !== undefined);
  const known = ids.map((id) => nodes.get(id)).filter(Boolean);
  const shadowDepth = known.length ? Math.max(...known.map((k) => k.shadowDepth)) : null;
  bucket.push({ method, shadowDepth, knownRefs: known.length, refs: ids.length, rootType: params.root?.shadowRootType });
  if (method === 'DOM.childNodeInserted') {
    const p = nodes.get(params.parentNodeId);
    indexNode(params.node, params.parentNodeId, (p?.depth ?? 0) + 1, p?.shadowDepth ?? 0);
  }
  if (method === 'DOM.shadowRootPushed') {
    const h = nodes.get(params.hostId);
    indexNode(params.root, params.hostId, (h?.depth ?? 0) + 1, (h?.shadowDepth ?? 0) + 1);
  }
  if (method === 'DOM.setChildNodes') {
    const p = nodes.get(params.parentId);
    for (const n of params.nodes ?? []) indexNode(n, params.parentId, (p?.depth ?? 0) + 1, p?.shadowDepth ?? 0);
  }
};

// Each body runs inside its own function scope and must `return` its result.
async function scenario(name, body) {
  bucket = [];
  const r = await send('Runtime.evaluate', { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true });
  await sleep(800);
  const byMethod = {};
  for (const e of bucket) byMethod[e.method] = (byMethod[e.method] || 0) + 1;
  return {
    name,
    page_result: r.result?.value ?? r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? null,
    events: bucket.length,
    by_method: byMethod,
    shadow_depths: [...new Set(bucket.map((e) => e.shadowDepth))],
    pushed_root_types: bucket.filter((e) => e.rootType).map((e) => e.rootType),
    unknown_refs: bucket.filter((e) => e.knownRefs < e.refs).length,
  };
}

await send('Runtime.evaluate', { expression: `
window.__lab2 = (() => {
  let best = null, bestDepth = -1;
  const walk = (root, d) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const first = el.shadowRoot.querySelector('*');
        if (first && d + 1 > bestDepth) { bestDepth = d + 1; best = { host: el, inner: first }; }
        walk(el.shadowRoot, d + 1);
      }
    }
  };
  walk(document, 0);
  return { best, bestDepth };
})(); window.__lab2.bestDepth`, returnByValue: true });

const results = [];
results.push(await scenario('light-dom: setAttribute on body', `document.body.setAttribute('data-lab','1'); document.body.removeAttribute('data-lab'); return 'ok';`));
results.push(await scenario('light-dom: append+remove child of body', `const s=document.createElement('span'); s.textContent='lab'; document.body.appendChild(s); s.remove(); return 'ok';`));
results.push(await scenario('existing open shadow: setAttribute on inner element', `const i=window.__lab2.best.inner; i.setAttribute('data-lab','1'); i.removeAttribute('data-lab'); return 'depth '+window.__lab2.bestDepth;`));
results.push(await scenario('existing open shadow: append+remove child', `const i=window.__lab2.best.inner; const s=document.createElement('span'); s.textContent='lab'; i.appendChild(s); s.remove(); return 'ok';`));
results.push(await scenario('existing open shadow: characterData change', `const i=window.__lab2.best.inner; const t=document.createTextNode('a'); i.appendChild(t); t.data='b'; t.remove(); return 'ok';`));
results.push(await scenario('new open shadow root: create host + attachShadow + inner mutation', `
  const h=document.createElement('div'); h.id='lab-open-host'; document.body.appendChild(h);
  const r=h.attachShadow({mode:'open'}); const b=document.createElement('b'); b.textContent='x'; r.appendChild(b);
  b.setAttribute('data-lab','1'); return 'ok';`));
results.push(await scenario('new open shadow root: mutate inside again (after push)', `const b=document.getElementById('lab-open-host').shadowRoot.firstChild; b.textContent='y'; b.setAttribute('data-lab','2'); return 'ok';`));
results.push(await scenario('new closed shadow root: create + inner mutation', `
  const h=document.createElement('div'); h.id='lab-closed-host'; document.body.appendChild(h);
  const r=h.attachShadow({mode:'closed'}); window.__labClosed=r; const b=document.createElement('b'); b.textContent='x'; r.appendChild(b); b.setAttribute('data-lab','1'); return 'ok';`));
results.push(await scenario('new closed shadow root: mutate inside again', `const b=window.__labClosed.firstChild; b.textContent='z'; b.setAttribute('data-lab','2'); return 'ok';`));
results.push(await scenario('cleanup', `document.getElementById('lab-open-host')?.remove(); document.getElementById('lab-closed-host')?.remove(); delete window.__labClosed; delete window.__lab2; return 'ok';`));

console.log(JSON.stringify({
  tree: { nodes: nodes.size, open_roots: countType('open'), closed_roots: countType('closed'), ua_roots: countType('user-agent') },
  scenarios: results,
}, null, 2));
ws.close();
