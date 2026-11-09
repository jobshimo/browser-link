// Lab extension: does the lab-3 mechanism work through chrome.debugger in MV3?
// Results are persisted in chrome.storage.local (the MV3 worker is terminated
// after ~30 s idle, so in-memory results are lost). The lab runs either from
// the toolbar action or from a runtime message sent by lab.html.

const AGENT = `
(() => {
  if (window.__blm) return;
  const blm = (window.__blm = { roots: 0, closedRoots: 0, pending: new Map(), flushes: 0, records: 0, doc: location.href });
  const opts = { subtree: true, childList: true, attributes: true, characterData: true };
  const onRecords = (recs) => {
    blm.records += recs.length;
    for (const r of recs) {
      const t = r.type === 'characterData' ? r.target.parentNode : r.target;
      if (!t) continue;
      let e = blm.pending.get(t);
      if (!e) { e = { childList: 0, attributes: 0, characterData: 0 }; blm.pending.set(t, e); }
      e[r.type]++;
    }
    if (!blm.scheduled) { blm.scheduled = true; setTimeout(flush, 16); }
  };
  function flush() {
    blm.scheduled = false;
    blm.flushes++;
    const summary = { doc: blm.doc, targets: blm.pending.size, records: 0 };
    for (const e of blm.pending.values()) for (const k in e) summary.records += e[k];
    blm.pending.clear();
    if (typeof window.__blmPush === 'function') window.__blmPush(JSON.stringify(summary));
  }
  const observe = (root, closed) => { new MutationObserver(onRecords).observe(root, opts); blm.roots++; if (closed) blm.closedRoots++; };
  observe(document, false);
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { const root = orig.call(this, init); observe(root, init && init.mode === 'closed'); return root; };
  const walk = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { observe(el.shadowRoot, false); walk(el.shadowRoot); } };
  walk(document);
})()`;

function cdp(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params ?? {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const persist = (res) => chrome.storage.local.set({ labResult: res });

async function runLab(tabId) {
  const target = { tabId };
  const res = { status: 'running', tabId, startedAt: Date.now(), steps: [], wire: { messages: 0, bytes: 0, records: 0, byDoc: {} } };
  await persist(res);
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === 'Runtime.bindingCalled' && params.name === '__blmPush') {
      const s = JSON.parse(params.payload);
      res.wire.messages++;
      res.wire.bytes += params.payload.length;
      res.wire.records += s.records;
      res.wire.byDoc[s.doc] = (res.wire.byDoc[s.doc] || 0) + 1;
    }
    if (method === 'Page.loadEventFired') res.steps.push('loadEventFired');
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await chrome.debugger.attach(target, '1.3');
    res.steps.push('attached');
    await cdp(target, 'Page.enable');
    await cdp(target, 'Runtime.enable');
    await cdp(target, 'Runtime.addBinding', { name: '__blmPush' });
    res.steps.push('binding added');
    const added = await cdp(target, 'Page.addScriptToEvaluateOnNewDocument', { source: AGENT, runImmediately: true });
    res.steps.push('script added ' + added.identifier);
    await persist(res);
    const state = async () => {
      const r = await cdp(target, 'Runtime.evaluate', { expression: 'window.__blm ? JSON.stringify({roots: __blm.roots, closedRoots: __blm.closedRoots, flushes: __blm.flushes, records: __blm.records, doc: __blm.doc}) : null', returnByValue: true });
      return r.result.value ? JSON.parse(r.result.value) : null;
    };
    res.phaseA = { agent: await state() };
    const t0 = Date.now();
    await sleep(8000);
    res.phaseA.wire = { ...res.wire, byDoc: { ...res.wire.byDoc }, bytes_per_s: Math.round(res.wire.bytes / ((Date.now() - t0) / 1000)) };
    res.phaseA.agentAfter = await state();
    await persist(res);
    const w0 = { messages: res.wire.messages, records: res.wire.records };
    await cdp(target, 'Page.reload');
    await sleep(6000);
    res.phaseB = { agent: await state(), wireDelta: { messages: res.wire.messages - w0.messages, records: res.wire.records - w0.records } };
    await persist(res);
    const w1 = res.wire.records;
    const r = await cdp(target, 'Runtime.evaluate', { expression: `(() => { const h=document.createElement('div'); h.id='lab-ext-closed'; document.body.appendChild(h); const root=h.attachShadow({mode:'closed'}); const b=document.createElement('b'); b.textContent='x'; root.appendChild(b); b.setAttribute('data-lab','1'); return window.__blm.closedRoots; })()`, returnByValue: true, awaitPromise: true });
    await sleep(1000);
    res.phaseC = { closedRootsSeen: r.result.value, recordsPushed: res.wire.records - w1 };
    await cdp(target, 'Runtime.evaluate', { expression: `document.getElementById('lab-ext-closed')?.remove(); 'ok'`, returnByValue: true });
    await cdp(target, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier });
    res.status = 'done';
  } catch (err) {
    res.status = 'error';
    res.error = String(err && err.message ? err.message : err);
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    try { await chrome.debugger.detach(target); } catch (_) {}
    res.finishedAt = Date.now();
    await persist(res);
  }
  return res;
}

chrome.action.onClicked.addListener((tab) => { runLab(tab.id); });

// lab.html sends { run: '<url substring>' }: pick the matching tab via
// chrome.debugger.getTargets (needs only the debugger permission).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.run) return;
  (async () => {
    const targets = await chrome.debugger.getTargets();
    const t = targets.find((x) => x.type === 'page' && x.url.includes(msg.run) && (!msg.prefix || x.url.startsWith(msg.prefix)));
    if (!t) { await persist({ status: 'error', error: 'no tab matching ' + msg.run }); sendResponse({ started: false }); return; }
    sendResponse({ started: true, tabId: t.tabId, url: t.url });
    await runLab(t.tabId);
  })();
  return true;
});
