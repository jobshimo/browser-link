/**
 * The Activity window.
 *
 * A dedicated extension page rather than a section of the 320px popup, for one
 * reason that is not cosmetic: a Chrome action popup closes the moment it loses
 * focus, so it physically cannot be watched while an agent works. This window
 * stays open, and can be parked on a second monitor while the agent runs.
 *
 * It owns no data. Every row comes from the server's `activity.db` through the
 * background service worker (`activityQuery` → WS `activity.query`), so what
 * this page shows survives closing the browser, and closing this page loses
 * nothing.
 */

/** Row shape as the server serialises it. Structural, not imported: the
 * extension must not take a build dependency on the server package. */
interface ActivityRecord {
  id: number;
  at: string;
  tool: string;
  tabId: string | null;
  transport: 'extension' | 'cdp' | null;
  url: string | null;
  title: string | null;
  agent: string | null;
  agentPid: number | null;
  selector: string | null;
  payload: string | null;
  outcome: 'ok' | 'error';
  error: string | null;
  durationMs: number;
  flowId: string | null;
}

interface ActivityStats {
  rows: number;
  bytes: number;
  oldest_at: string | null;
  newest_at: string | null;
  max_rows: number;
}

type QueryReply =
  | {
      ok: true;
      records: ActivityRecord[];
      latest_id: number;
      total: number;
      agents: { agent: string; count: number }[];
      stats: ActivityStats;
    }
  | { ok: false; error: string };

type PurgeReply =
  | { ok: true; removed: number; dry_run: boolean; stats: ActivityStats }
  | { ok: false; error: string };

/** How often the live tail asks for new rows. Two seconds reads as immediate
 * to a human watching an agent work, and costs one small indexed SELECT — far
 * cheaper than the render it usually skips because nothing changed. */
const TAIL_INTERVAL_MS = 2_000;

/** Rows held in the page. Beyond this the oldest are dropped from the DOM (not
 * from the trail — they are still on disk and in any export). A table that
 * grows without bound is how a panel left open overnight eats a gigabyte. */
const MAX_ROWS_IN_VIEW = 1_000;

/** Resolve a required element, failing loudly at load rather than producing a
 * page that silently does nothing when the template and this script drift. */
const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`activity: missing #${id}`);
  return node;
};

const ui = {
  live: el('live') as HTMLButtonElement,
  refresh: el('refresh') as HTMLButtonElement,
  exportBtn: el('export') as HTMLButtonElement,
  agent: el('filter-agent') as HTMLSelectElement,
  tool: el('filter-tool') as HTMLSelectElement,
  failed: el('filter-failed') as HTMLButtonElement,
  text: el('filter-text') as HTMLInputElement,
  reset: el('filter-reset') as HTMLButtonElement,
  count: el('count'),
  table: el('table') as HTMLTableElement,
  rows: el('rows') as HTMLTableSectionElement,
  state: el('state'),
  stateTitle: el('state-title'),
  stateDetail: el('state-detail'),
  status: el('status'),
  usageRows: el('usage-rows'),
  usageSize: el('usage-size'),
  usageSpan: el('usage-span'),
  usageMeter: el('usage-fill').parentElement as HTMLElement,
  usageFill: el('usage-fill'),
  usageCap: el('usage-cap'),
  purgeToggle: el('purge-toggle') as HTMLButtonElement,
  purgePanel: el('purge-panel'),
  purgeFrom: el('purge-from') as HTMLInputElement,
  purgeTo: el('purge-to') as HTMLInputElement,
  purgeSummary: el('purge-summary'),
  purgeCheck: el('purge-check') as HTMLButtonElement,
  purgeRun: el('purge-run') as HTMLButtonElement,
  purgeCancel: el('purge-cancel') as HTMLButtonElement,
  preset30d: el('purge-preset-30d') as HTMLButtonElement,
  preset7d: el('purge-preset-7d') as HTMLButtonElement,
  presetAll: el('purge-preset-all') as HTMLButtonElement,
};

let records: ActivityRecord[] = [];
let lastStats: ActivityStats | null = null;
/** Rows the last dry run said the current range would delete. Cleared whenever
 * the range changes, so the red button can never act on a stale count — the
 * user must always be shown a number for the range they are actually about to
 * purge. */
let pendingPurgeCount: number | null = null;
let live = true;
let tailTimer: ReturnType<typeof setInterval> | null = null;
/** Tools seen so far, so the filter offers exactly what exists rather than a
 * hardcoded list that goes stale when a tool is added. */
const knownTools = new Set<string>();

function ask(query: Record<string, unknown>): Promise<QueryReply> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'activityQuery', query }, (reply: QueryReply) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'unreachable' });
        return;
      }
      resolve(reply);
    });
  });
}

/** Server-side filters. The free-text box is deliberately NOT one of them: it
 * filters what is already loaded, so typing feels instant and never costs a
 * round trip. The dropdowns are, because they change which rows exist. */
function serverFilters(): Record<string, unknown> {
  const filters: Record<string, unknown> = { limit: 300 };
  if (ui.agent.value) filters.agent = ui.agent.value;
  if (ui.tool.value) filters.tool = ui.tool.value;
  if (ui.failed.getAttribute('aria-pressed') === 'true') filters.outcome = 'error';
  return filters;
}

/* ------------------------------------------------------------- time ------
 *
 * ONE RULE, no exceptions:
 *
 *   The trail stores UTC. The user only ever sees, and only ever types,
 *   their own local time.
 *
 * Everything the user reads goes through `toLocale*`. Everything the user
 * types is a local calendar day and is converted to a UTC instant here, at
 * this boundary, before it reaches the server. Nothing downstream of this
 * file thinks about timezones at all.
 *
 * Exports are the one deliberate exception and are NOT a display surface:
 * they keep raw UTC, because a file handed to another machine or another
 * agent must not carry this browser's timezone baked into it.
 */

/** A local calendar day (`2026-07-31` from an `<input type="date">`) widened
 * to the UTC instant at that day's local start or local end.
 *
 * Widening matters: without it, a purge "to Jul 31" would resolve to midnight
 * and silently spare everything that happened during Jul 31. */
function localDayToUtc(day: string, edge: 'start' | 'end'): string {
  // No `Z` and no offset — the runtime parses this as LOCAL time, which is
  // exactly what the date picker meant.
  const suffix = edge === 'start' ? 'T00:00:00.000' : 'T23:59:59.999';
  return new Date(`${day}${suffix}`).toISOString();
}

/** A Date as the local calendar day the picker expects (`YYYY-MM-DD`).
 * NOT `toISOString().slice(0, 10)` — that is the UTC day, which is the wrong
 * one for anybody whose offset has already rolled the date over. */
function toLocalDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Full local timestamp, for the hover on a relative time. */
function formatExact(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Bytes as a human reads them. Binary units because that is what a file
 * manager will show for the same file, and two numbers that disagree about the
 * same thing are worse than either alone. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatDay(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Repaint the always-visible usage strip.
 *
 * Called from every reply — reads and purges alike — so the numbers can never
 * be stale relative to what is on screen beneath them.
 */
function renderStats(stats: ActivityStats): void {
  lastStats = stats;
  ui.usageRows.textContent = stats.rows.toLocaleString();
  ui.usageSize.textContent = formatBytes(stats.bytes);
  ui.usageSpan.textContent = formatDay(stats.oldest_at);

  const ratio = stats.max_rows > 0 ? stats.rows / stats.max_rows : 0;
  ui.usageFill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
  ui.usageCap.textContent = `${stats.rows.toLocaleString()} / ${stats.max_rows.toLocaleString()}`;
  // Amber past 80%: the trail is close to dropping its oldest entries, which
  // is the one moment the user genuinely needs to decide between purging and
  // exporting first.
  ui.usageMeter.classList.toggle('warn', ratio >= 0.8);
}

function formatTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secondsAgo = Math.round((Date.now() - then) / 1000);
  if (secondsAgo < 5) return 'just now';
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

/** What the action acted on, in priority order. A selector says the most; a
 * payload is next; the URL is the fallback for tools that take neither. */
function targetOf(record: ActivityRecord): string {
  return record.selector ?? record.payload ?? record.url ?? '—';
}

function matchesText(record: ActivityRecord, needle: string): boolean {
  if (needle === '') return true;
  const hay = [record.tool, record.selector, record.url, record.payload, record.error, record.agent]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

function buildRow(record: ActivityRecord): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (record.outcome === 'error') tr.className = 'failed';

  const when = document.createElement('td');
  when.className = 'when';
  when.textContent = formatTime(record.at);
  when.title = formatExact(record.at);

  const agent = document.createElement('td');
  if (record.agent) {
    const badge = document.createElement('span');
    badge.className = 'agent';
    badge.textContent = record.agent;
    if (record.agentPid !== null) badge.title = `pid ${record.agentPid}`;
    agent.append(badge);
  } else {
    agent.textContent = '—';
  }

  const tool = document.createElement('td');
  tool.className = 'tool';
  tool.textContent = record.tool;
  if (record.flowId) {
    const tag = document.createElement('span');
    tag.className = 'flow-tag';
    tag.textContent = 'flow';
    tag.title = record.flowId;
    tool.append(tag);
  }

  const target = document.createElement('td');
  const main = document.createElement('span');
  main.className = 'target';
  main.textContent = targetOf(record);
  target.append(main);
  // Show the payload as a second line only when it is not already the target,
  // so a `type` row reads "#search / hunter2" without repeating itself.
  if (record.payload !== null && record.payload !== targetOf(record)) {
    const payload = document.createElement('span');
    payload.className = 'payload';
    payload.textContent = record.payload;
    target.append(payload);
  }
  if (record.url !== null && record.url !== targetOf(record)) {
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = record.url;
    target.append(url);
  }

  const outcome = document.createElement('td');
  outcome.className = `outcome ${record.outcome}`;
  outcome.textContent =
    record.outcome === 'ok' ? `ok · ${record.durationMs}ms` : (record.error ?? 'error');
  if (record.outcome === 'error' && record.error) outcome.title = record.error;

  tr.append(when, agent, tool, target, outcome);
  return tr;
}

function showState(title: string, detail = ''): void {
  ui.stateTitle.textContent = title;
  ui.stateDetail.textContent = detail;
  ui.state.classList.remove('hidden');
  ui.table.classList.add('hidden');
}

function render(): void {
  const needle = ui.text.value.trim().toLowerCase();
  const visible = records.filter((r) => matchesText(r, needle));

  if (visible.length === 0) {
    showState(
      records.length === 0 ? 'No activity yet' : 'Nothing matches this filter',
      records.length === 0
        ? 'Actions appear here the moment an agent touches a connected tab.'
        : 'Try clearing the search box or the dropdowns.',
    );
    ui.count.textContent = records.length === 0 ? '' : `0 of ${records.length} shown`;
    return;
  }

  ui.state.classList.add('hidden');
  ui.table.classList.remove('hidden');

  const fragment = document.createDocumentFragment();
  for (const record of visible) fragment.append(buildRow(record));
  ui.rows.replaceChildren(fragment);
  ui.count.textContent =
    visible.length === records.length
      ? `${visible.length} actions`
      : `${visible.length} of ${records.length} shown`;
}

function refreshAgentOptions(agents: { agent: string; count: number }[]): void {
  const current = ui.agent.value;
  const options = ['<option value="">All agents</option>'];
  for (const { agent, count } of agents) {
    options.push(`<option value="${escapeAttr(agent)}">${escapeHtml(agent)} (${count})</option>`);
  }
  ui.agent.innerHTML = options.join('');
  ui.agent.value = current;
}

function refreshToolOptions(): void {
  const current = ui.tool.value;
  const options = ['<option value="">All tools</option>'];
  for (const tool of [...knownTools].sort()) {
    options.push(`<option value="${escapeAttr(tool)}">${escapeHtml(tool)}</option>`);
  }
  ui.tool.innerHTML = options.join('');
  ui.tool.value = current;
}

/** The two option lists are the only place this page builds markup from a
 * string, and both values are server-owned. Escaped anyway: an agent label is
 * self-declared text, and "it cannot contain a quote today" is not a security
 * boundary. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

async function load(): Promise<void> {
  const reply = await ask(serverFilters());
  if (!reply.ok) {
    if (reply.error === 'not-connected') {
      showState(
        'No connected tab',
        'The trail lives in the browser-link server. Connect a tab from the popup to read it.',
      );
    } else {
      showState('Could not read the trail', reply.error);
    }
    ui.status.textContent = `error: ${reply.error}`;
    return;
  }

  records = reply.records;
  renderStats(reply.stats);
  for (const record of records) knownTools.add(record.tool);
  refreshAgentOptions(reply.agents);
  refreshToolOptions();
  ui.status.textContent = `${reply.total} actions recorded`;
  render();
}

/** Tail: ask only for what is newer than the newest row we hold, then prepend.
 * Cheaper than reloading the page of 300 on every tick, and it keeps the
 * user's scroll position where they left it. */
async function tail(): Promise<void> {
  const newest = records.at(0)?.id;
  if (newest === undefined) {
    await load();
    return;
  }
  const reply = await ask({ ...serverFilters(), since_id: newest });
  if (!reply.ok) return;
  renderStats(reply.stats);
  if (reply.records.length === 0) return;
  for (const record of reply.records) knownTools.add(record.tool);
  records = [...reply.records, ...records].slice(0, MAX_ROWS_IN_VIEW);
  refreshAgentOptions(reply.agents);
  refreshToolOptions();
  ui.status.textContent = `${reply.total} actions recorded`;
  render();
}

function setLive(next: boolean): void {
  live = next;
  ui.live.setAttribute('aria-pressed', String(live));
  if (tailTimer !== null) clearInterval(tailTimer);
  tailTimer = live ? setInterval(() => void tail(), TAIL_INTERVAL_MS) : null;
}

/**
 * Download what is on screen as NDJSON.
 *
 * NDJSON rather than JSON because a trail is append-only and line-oriented:
 * it greps, it tails, it diffs, and another agent can stream it without
 * parsing the whole file. Exports exactly the filtered view, because the
 * filter is how the user said what they wanted.
 *
 * Note this is the VISIBLE page. `browser-link activity export` is the tool
 * for the complete trail — and the one with `--redact`.
 */
function exportVisible(): void {
  const needle = ui.text.value.trim().toLowerCase();
  const visible = records.filter((r) => matchesText(r, needle));
  const body = visible.map((r) => JSON.stringify(r)).join('\n');
  const blob = new Blob([`${body}\n`], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  chrome.downloads.download({ url, filename: `browser-link-activity-${stamp}.ndjson` }, () => {
    // Revoke once Chrome has taken the bytes; leaking the object URL would
    // pin the whole export in memory for the life of the window.
    URL.revokeObjectURL(url);
  });
}

/* ---------------------------------------------------------------- purge --
 *
 * Two-step by construction: the red button stays disabled until a dry run has
 * put a real number in front of the user for the exact range they picked.
 * Changing either date wipes that number and disables it again.
 */

function purgeAsk(input: { from?: string; to?: string; dryRun?: boolean }): Promise<PurgeReply> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'activityPurge', ...input }, (reply: PurgeReply) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'unreachable' });
        return;
      }
      resolve(reply);
    });
  });
}

/** A `<input type="date">` gives a local calendar day; the trail stores UTC
 * instants. Widen each end to cover the whole day the user pointed at, or a
 * purge "to Aug 14" would silently spare everything that happened on Aug 14. */
function rangeFromInputs(): { from?: string; to?: string } {
  const from = ui.purgeFrom.value;
  const to = ui.purgeTo.value;
  return {
    ...(from ? { from: localDayToUtc(from, 'start') } : {}),
    ...(to ? { to: localDayToUtc(to, 'end') } : {}),
  };
}

function describeRange(): string {
  const from = ui.purgeFrom.value;
  const to = ui.purgeTo.value;
  if (!from && !to) return 'the entire trail';
  if (from && to) return `${from} → ${to}`;
  if (from) return `everything from ${from} onwards`;
  return `everything up to ${to}`;
}

/** Invalidate any resolved count. Called on every change to the range. */
function resetPurgeConfirmation(): void {
  pendingPurgeCount = null;
  ui.purgeRun.disabled = true;
  ui.purgeRun.textContent = 'Delete permanently';
  // Restate what is currently stored next to the range being chosen — deciding
  // what to delete is much easier with the total in the same sentence.
  const current =
    lastStats === null
      ? ''
      : ` Currently ${lastStats.rows.toLocaleString()} actions, ${formatBytes(lastStats.bytes)}.`;
  ui.purgeSummary.textContent = `Ready to check: ${describeRange()}.${current}`;
}

function setDaysAgo(days: number): void {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  ui.purgeFrom.value = '';
  // Purging "older than N days" is an open-ended range with only an upper
  // bound — the oldest row is wherever the trail happens to start.
  ui.purgeTo.value = toLocalDay(cutoff);
  resetPurgeConfirmation();
}

ui.purgeToggle.addEventListener('click', () => {
  const opening = ui.purgePanel.hasAttribute('hidden');
  if (opening) ui.purgePanel.removeAttribute('hidden');
  else ui.purgePanel.setAttribute('hidden', '');
  resetPurgeConfirmation();
});

ui.purgeCancel.addEventListener('click', () => {
  ui.purgePanel.setAttribute('hidden', '');
});

ui.preset30d.addEventListener('click', () => {
  setDaysAgo(30);
});
ui.preset7d.addEventListener('click', () => {
  setDaysAgo(7);
});
ui.presetAll.addEventListener('click', () => {
  ui.purgeFrom.value = '';
  ui.purgeTo.value = '';
  resetPurgeConfirmation();
});
ui.purgeFrom.addEventListener('change', resetPurgeConfirmation);
ui.purgeTo.addEventListener('change', resetPurgeConfirmation);

ui.purgeCheck.addEventListener('click', () => {
  ui.purgeCheck.disabled = true;
  ui.purgeSummary.textContent = 'Counting…';
  void purgeAsk({ ...rangeFromInputs(), dryRun: true }).then((reply) => {
    ui.purgeCheck.disabled = false;
    if (!reply.ok) {
      ui.purgeSummary.textContent = `Could not check: ${reply.error}`;
      return;
    }
    renderStats(reply.stats);
    pendingPurgeCount = reply.removed;
    if (reply.removed === 0) {
      ui.purgeSummary.textContent = `Nothing to delete in ${describeRange()}.`;
      ui.purgeRun.disabled = true;
      return;
    }
    ui.purgeSummary.textContent = `This will permanently delete ${reply.removed.toLocaleString()} of ${reply.stats.rows.toLocaleString()} actions (${describeRange()}).`;
    ui.purgeRun.disabled = false;
    ui.purgeRun.textContent = `Delete ${reply.removed.toLocaleString()} permanently`;
  });
});

ui.purgeRun.addEventListener('click', () => {
  if (pendingPurgeCount === null || pendingPurgeCount === 0) return;
  // Native confirm on purpose: it is modal, it cannot be missed, and this is
  // the last moment before rows stop existing.
  const ok = window.confirm(
    `Permanently delete ${pendingPurgeCount.toLocaleString()} actions (${describeRange()})?\n\nThis cannot be undone.`,
  );
  if (!ok) return;

  ui.purgeRun.disabled = true;
  ui.purgeRun.textContent = 'Deleting…';
  ui.purgeSummary.textContent = 'Deleting and reclaiming disk space…';
  void purgeAsk(rangeFromInputs()).then((reply) => {
    ui.purgeRun.textContent = 'Delete permanently';
    if (!reply.ok) {
      ui.purgeSummary.textContent = `Purge failed: ${reply.error}`;
      return;
    }
    renderStats(reply.stats);
    ui.purgeSummary.textContent = `Deleted ${reply.removed.toLocaleString()} actions. ${reply.stats.rows.toLocaleString()} left, ${formatBytes(reply.stats.bytes)} on disk.`;
    resetPurgeConfirmation();
    // The rows on screen may no longer exist — reload rather than leave the
    // table showing what was just deleted.
    records = [];
    void load();
  });
});

ui.live.addEventListener('click', () => {
  setLive(ui.live.getAttribute('aria-pressed') !== 'true');
});
ui.refresh.addEventListener('click', () => void load());
ui.exportBtn.addEventListener('click', exportVisible);
ui.failed.addEventListener('click', () => {
  ui.failed.setAttribute('aria-pressed', String(ui.failed.getAttribute('aria-pressed') !== 'true'));
  void load();
});
ui.agent.addEventListener('change', () => void load());
ui.tool.addEventListener('change', () => void load());
ui.text.addEventListener('input', render);
ui.reset.addEventListener('click', () => {
  ui.agent.value = '';
  ui.tool.value = '';
  ui.text.value = '';
  ui.failed.setAttribute('aria-pressed', 'false');
  void load();
});

// Stop tailing while the window is hidden. A background window polling every
// two seconds forever is a battery cost with no reader.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (tailTimer !== null) clearInterval(tailTimer);
    tailTimer = null;
  } else if (live) {
    setLive(true);
    void tail();
  }
});

setLive(true);
void load();
