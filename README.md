<div align="center">

# 🔗 browser-link

**Developer-focused bridge between your MCP client (Claude Code, OpenCode, GitHub Copilot CLI, …) and the Chrome tabs you explicitly enable.**

> Built for developers debugging real UIs from the agent's seat — reproducing bugs, validating fixes, teaching the agent how an app actually behaves. Not a consumer browser-automation product.

[![npm version](https://img.shields.io/npm/v/@jobshimo/browser-link.svg?v=1)](https://www.npmjs.com/package/@jobshimo/browser-link)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?v=1)](./LICENSE)
[![issues](https://img.shields.io/github/issues/jobshimo/browser-link.svg?v=1)](https://github.com/jobshimo/browser-link/issues)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?v=1)](https://github.com/jobshimo/browser-link/pulls)

</div>

---

> ### ⚠️ Read this before installing
>
> `browser-link` opens a bridge between your MCP client and the Chrome tabs
> you explicitly enable through a companion extension. On every tab where you
> press **"Connect this tab"** in the extension popup, the agent can read its
> DOM, click, type, press keys (trusted keyboard input), drag, run a
> multi-step `browser.flow` sequence, run arbitrary JavaScript, navigate,
> answer native dialogs (`alert` / `confirm` / `prompt`), follow popups
> opened by the page (`window.open` / `target=_blank`), and pre-grant or
> pre-deny browser permissions (geolocation, notifications, camera,
> microphone, clipboard, sensors) for the tab's origin — **including any
> logged-in session, saved card, wallet, banking page or admin panel that
> tab is currently showing**.
>
> This is a **developer tool**, not a consumer-grade browser-automation
> product. Treat the agent like a junior dev with remote control of those
> tabs. Only enable tabs where you would let an automated process act on
> your behalf, and disconnect them when you are done. **You are responsible
> for every action the agent performs on the tabs you explicitly enable.**

---

## Contents

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Use cases](#use-cases)
- [What the agent can do](#what-the-agent-can-do)
- [Persistent UI map](#persistent-ui-map)
- [Customising](#customising)
- [Security model](#security-model)
- [Where your data lives](#where-your-data-lives)
- [For contributors](#for-contributors)
- [Author](#author)
- [License](#license)

---

## What it is

A **development-oriented** MCP server that lets your editor's agent see
and act on a Chrome tab you explicitly enable — without giving it your
whole browser. Designed for the loop "user reports bug → agent reproduces
it in the real UI → agent fixes the code → agent re-verifies in the same
tab", not for unattended consumer automation.

- ✅ **What it does** — exposes **31** `browser.*` MCP tools: 25 to drive
  a connected tab (list_tabs, ping, snapshot, find, state,
  canvas_screenshot, click, type, press, drag, flow, navigate, evaluate,
  wait_for, wait_for_tab, dialog_respond, set_permission, console,
  network, network_body, claim/release/my_tabs, events, reset) plus 6
  persistent-map tools, so the agent learns your apps across sessions.
- ✅ **What it needs** — Node ≥ 22.13 and Chrome / Chromium / Edge / Brave
  / Vivaldi. No accounts, no telemetry, no outbound calls except `npm`
  when you run `Check for updates`.
- 🚫 **What it does NOT do** — touch tabs you have not pressed Connect on,
  send anything off your machine, persist domain data in the map
  (selectors and flows only, structure never content).
- 🔒 **How it stays private** — WebSocket bridge is loopback-only
  (`127.0.0.1:17529`) and kernel-attested per connection.

## Quick start

```bash
npm install -g @jobshimo/browser-link
browser-link
```

The second command opens a full-screen interactive UI (English / Spanish)
built on [Ink](https://github.com/vadimdemedes/ink). It walks you through
the four-step setup:

1. **Register `browser-link` with your MCP client.** Pick **Claude Code**
   (writes `~/.claude.json` / `%USERPROFILE%\.claude.json`), **OpenCode**
   (writes `~/.config/opencode/opencode.json` on every OS),
   or **GitHub Copilot CLI** (writes `~/.copilot/mcp-config.json`,
   override via `COPILOT_HOME`). Restart the client afterwards.
2. **Drop the trigger block into the agent's global `.md`.** Optional but
   recommended — see [Agent instructions](#agent-instructions) below.
   Without it the agent has no reason to call `browser.snapshot` when you
   say "the button is broken"; it will read code and guess.
3. **Install the Chrome extension.** The UI prints the absolute path to the
   bundled assets and the OS-specific steps (`chrome://extensions` →
   Developer mode → Load unpacked).
4. **Connect a tab.** Click the browser-link icon in your Chrome toolbar
   and press **Connect this tab** on the tab you want the agent to see.
   The popup and its copy are English-only.

```
╭─ browser-link — setup ────────────────────────────────────────────╮
│ v0.19.1                                                            │
│                                                                     │
│ Pick an action                          ⋅ or press the bracketed key│
│                                                                     │
│ SETUP                                                               │
│ ❯ [r] Register browser-link with an MCP client                     │
│   [i] Agent instructions — trigger block in global .md              │
│   [p] Permissions — which browser.* tools to expose                 │
│   [m] Multi-agent — let multiple MCP clients share one bridge       │
│                                                                     │
│ DIAGNOSE                                                            │
│   [d] Run doctor (diagnose current setup)                           │
│   [u] Check for updates on npm                                      │
│   [f] Free port — stop a stuck browser-link holding 17529           │
│                                                                     │
│ REFERENCE                                                           │
│   [e] Show Chrome extension install steps                           │
│   [L] Language — switch between English and Español                │
│   [w] Show the welcome screen                                       │
│   [a] About / Help — what is this and how it works                  │
│   [g] Open the GitHub repository                                    │
│   [q] Quit                                                          │
│                                                                     │
│ ↑↓ navigate · ↵ select · a-z hotkey · l language · q quit           │
╰─────────────────────────────────────────────────────────────────────╯
```

Every action above is also a subcommand you can script:

```bash
browser-link install                       # register in every detected client
browser-link install --client claude       # register only in Claude Code
browser-link uninstall --client opencode   # remove from one client
browser-link instructions                  # status of the trigger block per client
browser-link instructions install          # insert/refresh the block in every detected client
browser-link instructions uninstall --client claude
browser-link extension                     # show extension assets path + steps
browser-link doctor                        # diagnose current setup
browser-link tools                         # show which MCP tools are enabled
browser-link tools disable browser.evaluate
browser-link tools preset readonly         # all | readonly | no-eval | no-map
browser-link config get                    # list every known setting
browser-link config set idle-ttl 15        # idle-disconnect TTL, in minutes ("never" disables it)
browser-link multi-agent disable           # opt out of the default shared-bridge mode
browser-link multi-agent auto-reelect enable
browser-link stop                          # kill a browser-link holding port 17529 (zombie)
browser-link updates                       # check the npm registry for a newer version
browser-link about                         # the full help page
browser-link help                          # list every subcommand
```

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│  Your MCP client (Claude Code, OpenCode, Copilot CLI, …)         │
└──────────────────────┬───────────────────────────────────────────┘
                       │  stdio (MCP)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  browser-link MCP server (Node ≥ 22.13)                          │
│  ─ listens on 127.0.0.1:17529  (loopback only)                   │
│  ─ exposes browser.* tools + browser.map.* persistent UI map     │
└──────────────────────┬───────────────────────────────────────────┘
                       │  WebSocket (loopback)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Chrome extension (Manifest V3, custom, ships with the package)  │
│  ─ inert by default                                              │
│  ─ activates per-tab when the user clicks "Connect this tab"     │
│  ─ uses chrome.debugger (Chrome DevTools Protocol) underneath    │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
                  Browser tab
              (only the connected ones)
```

- The WebSocket bridge **only binds to `127.0.0.1`** — never on a public
  interface, never reachable from anywhere outside your machine.
- Tabs you do **not** connect remain invisible to the agent. You connect
  them one by one, by hand.
- Disconnecting a tab from the extension popup immediately revokes the
  bridge for that tab. The bridge itself survives MCP client restarts —
  if no tool call lands for the configured idle TTL (30 minutes by
  default, user-configurable, see [Idle-disconnect TTL](#idle-disconnect-ttl)),
  the extension parks the tab on its own and you re-press Connect when
  you want it back.

## Use cases

- Reproduce a reported bug on a tab and verify it exists.
- Validate that a fix actually solved a bug, end-to-end, in the real UI.
- Give the agent real context (DOM, console, network) about what is
  happening in a view it is investigating.
- Build incremental UI knowledge: the agent learns selectors, flows and
  gotchas for each app and remembers them across sessions.

## What the agent can do

The MCP server registers two families of tools — 25 bridge tools that
drive the connected tab (13 read, 12 action) and 6 persistent-map tools
(2 read, 4 write). All 31 are individually toggle-able — see
[Per-tool permissions](#per-tool-permissions).

**Browser bridge — read-only** (no claim required, observation only):

| Tool                        | Purpose                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `browser.list_tabs`         | List tabs currently connected through the extension, with claim status (`claimed_by` / `claimed_by_me`)             |
| `browser.my_tabs`           | List the tabs the calling agent currently holds a claim on                                                          |
| `browser.ping`              | Verify the bridge to a tab; returns its title and URL                                                               |
| `browser.snapshot`          | Title, URL, visible text and interactive elements with selectors; filterable, pierces open Shadow DOM + iframes     |
| `browser.find`              | Locate one element by visible text → selector + coordinates; `near_misses` on no match, `candidates` on ambiguity   |
| `browser.state`             | Compact orientation read — URL/title/viewport/focused element/open dialogs/scroll — cheaper than a full snapshot    |
| `browser.canvas_screenshot` | Screenshot a `<canvas>` as PNG/JPEG, for DOMless UIs (Qt-WASM, WebGL) where snapshot/find return nothing            |
| `browser.console`           | Rolling buffer of recent console messages (last 200)                                                                |
| `browser.network`           | Rolling buffer of recent network requests (last 200)                                                                |
| `browser.network_body`      | Fetch the response body of one request by `request_id`                                                              |
| `browser.wait_for`          | Wait for a selector / JS expression / network request URL to match a condition                                      |
| `browser.wait_for_tab`      | Wait for a popup/`window.open` tab spawned by a connected tab; auto-claims it for the caller                        |
| `browser.events`            | Bridge lifecycle log (tab registered/disconnected/renamed/claimed/released, primary elected); paged with `since_id` |

**Browser bridge — actions** (most auto-claim the tab on first use — the
two exceptions are footnoted):

| Tool                     | Purpose                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `browser.navigate`       | Send a tab to a different URL (waits for load by default)                                            |
| `browser.click`          | Click an element by CSS selector; hit-tests for occlusion first (`force:true` to bypass)             |
| `browser.type`           | Focus an input and type text via the native value setter                                             |
| `browser.press`          | Trusted CDP key press (+ modifiers) — real `isTrusted:true` input, for widgets synthetic events miss |
| `browser.drag`           | Drag element→element or coordinate→coordinate; HTML5 or pointer-based, auto-detected                 |
| `browser.flow`           | Run a declarative find/click/type/press/wait_for sequence in one round trip; fail-fast, max 20 steps |
| `browser.evaluate`       | Run an arbitrary JavaScript expression in the page and return its result                             |
| `browser.dialog_respond` | Answer a pending native `alert` / `confirm` / `prompt` / `beforeunload` [^dialog-claim]              |
| `browser.set_permission` | Pre-grant or pre-deny a browser permission (geo, notifications, camera, …) for an origin             |
| `browser.claim_tab`      | Reserve a tab cooperatively for the calling agent (multi-agent mode)                                 |
| `browser.release_tab`    | Release a tab claim the calling agent holds                                                          |
| `browser.reset`          | Soft-reset the bridge — drop tabs, claims and events; keep the server alive [^reset-global]          |

[^dialog-claim]:
    `dialog_respond` deliberately bypasses the claim guard — a dialog
    freezes the tab's JS thread, and unblocking it should not require
    holding the claim. First responder wins.

[^reset-global]:
    `reset` is global — it takes no `tab_id` and touches no claim; it
    drops every tab, claim and event on the bridge at once.

`click` / `type` / `press` share a `settle_ms` option (see below). `find`,
`click`, `type`, `press` and `snapshot`/`state` all pierce open Shadow DOM
roots and same-origin iframes, nested arbitrarily.

### Behavior worth knowing before you rely on it

| Behavior                         | What to know                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shadow DOM / iframe piercing** | `snapshot`, `find`, `state`, `click`, `type` and `press` reach into OPEN shadow roots and same-origin iframes, nested arbitrarily. They CANNOT reach CLOSED shadow roots (`attachShadow({mode:"closed"})`) or cross-origin iframes — there is no CDP-level workaround for either. A selector that matches structurally-identical twins across roots comes back with `ambiguous: true`; use it immediately and never cache it in the map. |
| **Occlusion guard**              | `browser.click` hit-tests the target's own click point before dispatching. If a different element covers that point, the call returns `ok:false` describing the blocker instead of clicking the wrong thing blindly. Pass `force:true` to bypass the guard intentionally.                                                                                                                                                                |
| **`near_misses`**                | When `browser.find` matches nothing, the response can carry up to 3 ranked candidates as hints for a follow-up `find` call — they are suggestions for re-finding, never selectors to click on directly.                                                                                                                                                                                                                                  |
| **`browser.flow` recipes**       | The persistent map can store named, replayable flow recipes validated against the exact `browser.flow` step grammar, and the placeholder privacy rule that protects them — see [Persistent UI map](#persistent-ui-map).                                                                                                                                                                                                                  |

#### `settle_ms` — settle proves QUIET, not EFFECT

`click` / `type` / `press` accept a `settle_ms` option (default 150 ms,
`0` disables it): after dispatching the action they wait until the page
goes quiet — no DOM mutations for that many consecutive milliseconds —
and fold the "wait, then re-check" round trip into the action call
itself. The result carries a compact report:

```
{ settled, duration_ms, mutation_count, url_changed?, focus_moved?, reason? }
```

- **Quiet is not effect.** Mutations that finish before the observer
  installs, and async reactions that start after the quiet window, are
  both invisible — `mutation_count: 0` with `settled: true` does NOT
  prove the action had no effect.
- **`reason: "context-destroyed"`** means the action navigated the page,
  destroying the observer's execution context. The action itself still
  succeeded — this is a strong navigation signal, not an error.
- **Waiting for a specific expected condition** (an element appearing, a
  request completing) is `browser.wait_for`'s job, not settle's.

**Persistent UI map** — local-only memory across sessions:

| Tool                     | Purpose                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `browser.map.recall`     | Recall selectors / flow notes / gotchas / named flow recipes known for an app+route             |
| `browser.map.save`       | Persist a `selector`, `flow` note or `gotcha`, and/or one or more named replayable flow recipes |
| `browser.map.record_use` | Mark an entry as freshly verified or failed (not applicable to named flow recipes)              |
| `browser.map.forget`     | Delete an entry or an entire app                                                                |
| `browser.map.rename_app` | Fix an auto-derived app_key                                                                     |
| `browser.map.apps`       | List known apps                                                                                 |

On every MCP `initialize` handshake the server pushes a structured usage
protocol to the client (when to call `recall`, what kinds to save, what
to _never_ save) — no manual prompt engineering required.

## Persistent UI map

> Every time the agent figures something out about a web app (where a
> button lives, which combination of events fires its handler, what
> gotcha tripped it the first time, or a whole multi-step path worth
> replaying later), it can persist that knowledge in a **local SQLite
> database** under your user folder. Next session, the agent calls
> `browser.map.recall` and gets that knowledge back — instead of
> rediscovering the same selectors and flows from scratch every
> conversation. **This is what makes `browser-link` more than a remote
> control.**

### What gets remembered

Two layers, both indexed by app:

**Ad-hoc entries**, indexed by `(app, route)` — three kinds:

| Kind         | What it looks like                                                                   | When the agent saves it                                                        |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **selector** | `{ selector: "button[aria-label='Save']", evidence?: "found via snapshot" }`         | A CSS selector tied to a stable purpose                                        |
| **flow**     | `{ steps: [{action:'click', selector:'#chip'}, {action:'wait', ms:500}, …] }`        | A free-form note about a multi-step path — not `browser.flow`-replayable as-is |
| **gotcha**   | `{ body: "Synthetic dblclick does not fire the React handler — use full sequence" }` | A non-obvious fact about the app that would take time to rediscover            |

**Named flow recipes** (v0.18.0) — a separate `flows` table, one row per
named, directly **`browser.flow`-replayable** sequence, validated against
the exact `browser.flow` step grammar (`find`/`click`/`type`/`press`/`wait_for`)
before it is ever written. `browser.map.save({ flows: [{ name,
description?, steps }] })` upserts on `(app, name)`; `browser.map.recall`
returns the app's saved recipes (`name`, `description`, `steps`,
`use_count`) alongside the entries above, unfiltered by route. The
intended loop: `recall` → **adapt** any placeholder text in `steps` (e.g.
`type text "<QUERY>"`) to the real value the user asked for → call
`browser.flow` with the adapted steps. `browser.map.record_use` does not
apply to recipes — re-saving a recipe with the same `name` refreshes it
instead.

**Placeholder privacy rule** applies to both layers: never store domain
data (IDs, user names, dates, message content). Free text inside a
`flow` note or a flow recipe's `steps` uses a placeholder like `<QUERY>`
or `<NAME>`, never the value the user actually typed.

Each entry has `verified_at` / `failed_at` timestamps so the agent
knows whether the saved knowledge is fresh, stale, or known-broken.
When a selector that used to work suddenly fails, the agent marks it
via `record_use({ ok: false })` and stops trusting it until it relearns.

### The loop, in plain English

```
You ask:
    "Open the user detail dialog for user 42 and check the audit log"
         │
         ▼
1) Agent → browser.map.recall({ origin, url })
   returns selectors / flow notes / gotchas / flow recipes it learned for this app
         │
         ▼
2) Agent reuses what it knows — saves time and tokens
   stale entries fall back to snapshot and relearn; wrong ones get marked;
   a flow recipe gets its placeholders substituted, then replayed via browser.flow
         │
         ▼
3) Agent does the task and saves any new learning via browser.map.save
   so the next session starts even better-equipped
```

### Schema

```sql
CREATE TABLE apps (
  id, origin, app_key, title, notes, created_at, last_seen_at
);

CREATE TABLE entries (
  id, app_id, url_pattern, kind, purpose,
  payload TEXT,                  -- JSON blob, shape depends on kind
  verified_at, failed_at, notes,
  created_at, updated_at
);

CREATE TABLE flows (
  id, app_id, name, description,
  steps_json,                    -- ordered find/click/type/press/wait_for steps
  use_count, created_at, updated_at
  -- UNIQUE(app_id, name)
);
```

## Customising

A handful of knobs — some on by default, all reversible.

### Agent instructions

Having the MCP tools registered is necessary but not sufficient. Agents
reach for what their global instructions point at — and out of the box
they have no reason to call `browser.snapshot` when you say "the button
is broken". `browser-link instructions install` drops a fenced trigger
block into the agent's **global** instructions markdown:

| Client             | File                                                 |
| ------------------ | ---------------------------------------------------- |
| Claude Code        | `~/.claude/CLAUDE.md`                                |
| OpenCode           | `~/.config/opencode/AGENTS.md`                       |
| GitHub Copilot CLI | `~/.copilot/AGENTS.md` (override via `COPILOT_HOME`) |

The block is fenced by HTML-comment markers, so reinstall overwrites in
place and uninstall removes exactly the span we manage. The version stamp
in the begin marker lets future releases detect outdated blocks
(`browser-link doctor` shows `⚠ outdated` until you re-run install).

### Per-tool permissions

`browser-link` exposes **31 MCP tools** — 25 bridge tools that drive the
connected Chrome tab (13 read, 12 action) and 6 to read/write the
persistent UI map (2 read, 4 write). **All 31 are individually
toggle-able**, so you can narrow the surface per machine:

- **In the menu** → `Permissions`. Toggle individual tools with **Space**
  or apply a preset with **Enter** (`all` / `readonly` / `no-eval` /
  `no-map`). Press **s** to save.
- **From the shell**:

```bash
browser-link tools                              # current state of all 31 tools
browser-link tools disable browser.evaluate     # block JS execution
browser-link tools disable browser.reset        # block destructive soft-reset
browser-link tools disable browser.set_permission   # block permission grants
browser-link tools preset readonly              # observation-only profile
browser-link tools enable browser.click         # turn one back on
```

Presets, in plain English:

| Preset     | What it disables                                                                                                                                                                                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`      | Nothing — every tool enabled (default).                                                                                                                                                                                                                                                                                                                         |
| `readonly` | The 12 non-read bridge tools (`navigate` / `click` / `type` / `press` / `drag` / `flow` / `evaluate` / `dialog_respond` / `set_permission` / `claim_tab` / `release_tab` / `reset`) and the 4 map-write tools (`save` / `record_use` / `forget` / `rename_app`). Leaves the 13 read bridge tools and the 2 map-read tools (`recall` / `apps`) — 15 tools total. |
| `no-eval`  | Just `browser.evaluate`. Everything else stays on — useful for "agent can drive but cannot run arbitrary JS".                                                                                                                                                                                                                                                   |
| `no-map`   | All 6 persistent-map tools. Bridge tools stay on.                                                                                                                                                                                                                                                                                                               |

The deny list lives in `config.json` next to the map DB. Changes are
**live**: the server re-reads the file on every `tools/list` and
`tools/call`, so toggles take effect on the agent's next tool call — no
MCP client restart needed.

### Multi-agent mode

**Multi-agent mode is ON by default** (`multiAgent` and `autoReelect`
both default to `true`). The first `browser-link` spawn becomes primary
and binds the WS port; a second `browser-link` spawn from another MCP
client automatically becomes a thin proxy that forwards MCP requests to
the primary over an internal IPC port, instead of failing with a clear
"port in use" error. Turn it off if you want a single MCP client to have
exclusive access:

```bash
browser-link multi-agent disable
browser-link multi-agent auto-reelect disable    # optional, only relevant while multi-agent is on
```

(Or from the setup menu → **Multi-agent**.)

With it on, every client sees the **same** connected Chrome tabs and the
**same** persistent UI map. The IPC bridge listens on `127.0.0.1:17530`
and applies the same kernel-level process-binding check as the WS port:
only Node-family binaries that present a fresh token from
`config-dir/multi-agent-token` are accepted.

**Auto-reelect on primary close**: if the primary's MCP client closes,
secondary proxies enter a 5-second reconnect window — in-flight
requests get a `-32001 "temporarily unavailable"` envelope while the
proxy waits for the new primary to bind the WS port. When it appears,
the proxy hot-swaps and traffic resumes.

**Traceability — `browser.events`**: every primary keeps an in-memory
ring buffer of bridge events (`primary-elected`, `tab-registered`,
`tab-disconnected`, `tab-renamed`, `tab-claimed`, `tab-released`,
`tab-claim-rejected`). When a tool call fails with "Tab not connected:
tab_X" the error message itself tells the agent to call
`browser.events`, where a `tab-renamed` entry maps the old id to the
new one — the agent recovers on its own. The Chrome extension
cooperates by remembering the last tab_id in `chrome.storage.session`
and asking the new primary to honour it on reconnect.

**Claim registry — cooperative tab ownership**: in multi-agent mode,
two agents touching the same tab can step on each other. Each tab
gets a soft owner via `browser.claim_tab`; the agent gets exclusive
access for an inactivity-based TTL and releases with
`browser.release_tab`. The primary sweeps stale claims so a crashed
agent never holds a tab forever. `browser.my_tabs` lists the tabs the
calling agent currently owns. Claims are advisory — they inform, they
do not block — so a single-client workflow never has to think about
them.

### Idle-disconnect TTL

By default, a connected tab whose bridge sees no `tool.request` for 30
minutes gets automatically parked (WS closed, debugger detached — the
popup goes back to "Not connected"). This is configurable two ways,
and both edit the **same** logical setting:

**From the extension popup** — a small control below the Connect
button: `Auto-disconnect idle tabs: [30 min ▾]`, with presets from 5
minutes up to 2 hours plus `Never` (disables auto-disconnect entirely).
Applies immediately — no extension reload needed. A CLI-set value
outside the preset list (say, 45) shows up as `45 min (custom)` in the
dropdown rather than leaving it blank.

**From the shell:**

```bash
browser-link config get idle-ttl              # show the current CLI-side value
browser-link config set idle-ttl 15           # 15 minutes
browser-link config set idle-ttl never        # disable auto-disconnect
```

(Values outside 1-1440 minutes are clamped to the nearest bound; a
non-numeric value is rejected with an error instead of being applied.)

Lowering the TTL applies against each tab's **absolute** last-activity
time, not the moment you changed the setting — a tab that has already
been idle longer than the new TTL disconnects on the next sweep (within
about a minute).

**Precedence — last write wins.** The popup and the CLI both stamp an
`updatedAt` timestamp on every change. When a tab (re)connects, the
server sends its last CLI-set value (if any) to the extension; the
extension only applies it when it is **newer** than whatever was last
set locally (typically from the popup). If the CLI has never touched
the setting, the server never pushes anything, so a popup-only user is
never bothered. `config set idle-ttl` also tries to push the new value
to **already-connected** tabs immediately, over the multi-agent IPC
bridge (see above) — this requires a `browser-link` primary to be
running with multi-agent mode on (the default); otherwise the value is
saved and applies the next time a tab connects. Comparing raw
timestamps between the CLI (Node) and the extension (Chrome) is safe
here specifically because both always run on the same machine — this
is a loopback-only bridge, not a distributed system.

## Security model

The WebSocket bridge binds to `127.0.0.1:17529` — loopback only, never
on a public interface. On top of that, before accepting any WebSocket
handshake the server asks the operating-system kernel **which process**
opened the incoming TCP connection. If the owning binary is not a known
Chromium-based browser (Chrome, Chromium, Edge, Brave, Vivaldi) the
handshake is refused with HTTP 403 before any application bytes are
exchanged.

- **macOS / Linux** → `lsof` (`/proc/net/tcp` on Linux is enough too).
- **Windows** → `netstat -ano` locates the owning PID; the process name
  is then resolved via PowerShell `Get-Process`, with `tasklist` as the
  fallback when PowerShell is missing, locked down, or slow.

Concretely this means:

- ✔ Random local processes (curl, other Node scripts, scanners) cannot
  talk to the bridge even if they figured out the port.
- ✔ A process that crafts a fake `Origin: chrome-extension://...` header
  is still rejected: the kernel reports its real binary name.
- ✘ Malware that has already injected itself **inside Chrome** (via
  `chrome.debugger` from another extension, dylib injection, gdb attach…)
  passes the check. But that attacker already controls the browser
  directly — the bridge gives them nothing they did not already have.

No tokens to paste, no manifests to register, no manual step beyond
clicking "Connect this tab" in the extension popup. `browser-link doctor`
lists the current allowlist on your OS.

## Where your data lives

The persistent map is a single SQLite file (`map.db`) on **your
machine**, never uploaded:

| OS      | Path                                                                                        |
| ------- | ------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/browser-link/map.db`                                         |
| Linux   | `$XDG_DATA_HOME/browser-link/map.db` <br/> _(default `~/.local/share/browser-link/map.db`)_ |
| Windows | `%APPDATA%\browser-link\map.db`                                                             |

Override with `BROWSER_LINK_DATA_DIR` if you want a portable install
or need to inspect the DB out-of-the-way. The same directory holds
`config.json` (UX preferences, per-tool permissions, and the CLI-side
idle-disconnect TTL) and `multi-agent-token` (rotated at every primary
startup).

Nothing in this package phones home. The WebSocket bridge talks
loopback only.

## For contributors

Open project, contributions welcome. Code is the quickest way, but
bug reports, repro cases, and ideas in the issue tracker are just as
useful.

- **Bug or feature idea**: open an issue at
  [github.com/jobshimo/browser-link/issues](https://github.com/jobshimo/browser-link/issues).
- **Pull request**: fork, branch from `main`, push, open a PR. All
  merges go through review.

### Repository layout

```
browser-link/
├── .github/
│   ├── dependabot.yml       # grouped weekly dependency updates + self-heal workflow
│   └── workflows/           # ci.yml, codeql.yml, version-gate.yml, dependabot-version-bump.yml
├── packages/
│   ├── server/      # MCP server + CLI binary published as @jobshimo/browser-link
│   ├── extension/   # Manifest V3 Chrome extension, bundled into the npm tarball
│   └── shared/      # workspace-internal type-only package
├── scripts/
│   ├── release.mjs          # local release engine: bump versions + open the release PR
│   ├── version-gate.mjs     # CI gate: blocks a PR whose versions are not aligned
│   ├── dependabot-bump-version.mjs   # self-heal a Dependabot PR that failed the gate
│   └── lib/versions.mjs     # shared version utilities (VERSIONED_FILES, semver helpers)
├── LICENSE
├── README.md        # this file
└── DECISIONS.md     # living architecture / design-decision log
```

### Development setup

Requires **Node ≥ 22.13** and **pnpm 11+**. The exact pnpm version is
pinned in `package.json` via the `packageManager` field — `corepack`
(bundled with Node ≥ 16) reads that field and uses the matching pnpm
version automatically.

```bash
git clone https://github.com/jobshimo/browser-link.git
cd browser-link
corepack enable          # one-time, picks up the pinned pnpm version
pnpm install
pnpm run build
```

| Script                     | What it does                                            |
| -------------------------- | ------------------------------------------------------- |
| `pnpm run build`           | Build the server and the Chrome extension               |
| `pnpm run build:server`    | Build only the server (`packages/server/dist/`)         |
| `pnpm run build:extension` | Build only the extension (`packages/extension/dist/`)   |
| `pnpm run dev`             | Run the server in watch mode (recompiles on save)       |
| `pnpm run try`             | Run the TUI directly from source via `tsx`              |
| `pnpm run typecheck`       | Type-check every workspace, no emit                     |
| `pnpm run test`            | Run every workspace's Vitest suite (server + extension) |
| `pnpm run inspect`         | Launch the MCP Inspector wired to the local server      |
| `pnpm run generate:icons`  | Regenerate extension PNGs from `icons/icon.svg`         |
| `pnpm run clean`           | Remove every `dist/` directory                          |

Both packages ship their own Vitest suite: the server's runs under plain
Node, the extension's runs under `jsdom` (popup, background service
worker, and the in-page selector/click/settle builders are all
unit-tested by evaluating the exact shipped JS strings). Run them
together with `pnpm run test`, or scope to one package with
`pnpm --filter @jobshimo/browser-link run test` /
`pnpm --filter @browser-link/extension run test`.

> ### ⚠️ `pnpm run dev` conflicts with a running MCP client
>
> `pnpm run dev` binds the same `127.0.0.1:17529` the registered MCP
> server uses. **Two processes cannot bind the same port at the same
> time.** While developing locally:
>
> - If your MCP client (Claude Code, OpenCode, …) is open with
>   `browser-link` registered, it already spawned the server and owns
>   the port. `pnpm run dev` will crash with `EADDRINUSE`.
> - If `pnpm run dev` is holding the port, the client's `browser-link`
>   MCP will fail to start.
>
> Recommended dev flow: quit the MCP client (or `browser-link stop` to
> kill the spawn it left holding the port) → run `pnpm run dev` → when
> done, stop `pnpm run dev` and reopen the client so it can spawn its
> own server. `pnpm run build` (no watch) does **not** touch the port,
> so you can always rebuild while the client is open.

Architecture decisions are kept in [`DECISIONS.md`](./DECISIONS.md).

### Cutting a release

**Hard rule enforced by CI**: every PR merged into `main` MUST bump the
version, and the five versioned files in the monorepo (root, server,
extension `package.json`, extension `manifest.json`, shared) MUST agree
on the same number. The `Version Gate` workflow blocks any PR that
doesn't comply and is a required check on `main`. **Every merge to
`main` is a release.**

```bash
pnpm run release -- patch    # 0.7.0 → 0.7.1
pnpm run release -- minor    # 0.7.0 → 0.8.0
pnpm run release -- major    # 0.7.0 → 1.0.0
pnpm run release -- 0.7.1    # explicit version
```

What `scripts/release.mjs` does, in order:

1. Refuses to start unless your working tree is clean, you are on `main`,
   and `main` is in sync with `origin/main`.
2. Refuses to start unless every `version` field across the monorepo is
   already aligned.
3. Bumps every version field to the new number.
4. Runs `pnpm install --lockfile-only` so `pnpm-lock.yaml` matches.
5. Generates a CHANGELOG entry at the top of
   `packages/server/CHANGELOG.md` from conventional commits since the
   previous tag, grouped by section.
6. Commits the lot on a new branch `release/vX.Y.Z` and pushes it.
7. Opens a PR against `main` with the CHANGELOG entry in the body.

You then review the PR and merge it via the GitHub UI. On merge, the
`release` job in `.github/workflows/ci.yml`:

1. Reads the version from `packages/server/package.json`.
2. Creates the tag `vX.Y.Z` and the matching GitHub Release.
3. Publishes `@jobshimo/browser-link@vX.Y.Z` to npm via **OIDC Trusted
   Publisher** — no `NPM_TOKEN` stored anywhere, the publish
   credentials are short-lived and granted per-run by GitHub Actions.

The job is idempotent: if the release / tag for that version already
exists, those steps are skipped.

## Author

**Martín Miguel Bernal** — [github.com/jobshimo](https://github.com/jobshimo)

## License

[MIT](./LICENSE) — © 2026 Martín Miguel Bernal
