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
- [cdp-direct mode (no extension)](#cdp-direct-mode-no-extension)
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
browser-link config set flow-recording on  # opt in to recording flows by demonstration (off by default)
browser-link config set cdp-direct.enabled true  # opt in to cdp-direct mode (off by default, see below)
browser-link cdp allow                     # grant time-boxed cdp-direct access (only you can run this)
browser-link cdp status                    # enabled?, port, grant remaining, endpoint reachable?
browser-link cdp revoke                    # revoke the current cdp-direct grant
browser-link map                           # list apps the persistent UI map knows about
browser-link map show <app>                # entries + flows for one app (app_key or origin)
browser-link map forget <app> --yes        # delete a whole app and its data
browser-link map forget <app> --flow <name> # delete just one named flow
browser-link map export --out map.json     # export the map (or one app) as JSON
browser-link map import map.json           # import an export (merge by default, --replace to overwrite)
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

### FAQ: the yellow "started debugging this browser" bar

**What it is.** Driving a tab through `chrome.debugger` (see the diagram
above) makes Chrome show a yellow infobar on that tab for as long as the
debugger session is attached. It is Chrome's own UI, not something
browser-link renders — no extension can hide or dismiss it through its own
APIs.

**Why it exists.** This is intentional transparency on Chrome's part, and
we treat it the same way — see the CDP-interaction decision in
[`DECISIONS.md`](./DECISIONS.md): the bar is the one unmistakable signal
that a tab is currently intervened, so you always know which tab an agent
can see and act on. browser-link does not try to work around it.

**Silencing it — an informed opt-out, not a fix.** Chrome supports a launch
flag, `--silent-debugger-extension-api`, that suppresses the infobar. This
is a Chrome switch you apply yourself when starting the browser; browser-link
does not set it for you:

- **Windows** — right-click the shortcut you use to launch Chrome →
  Properties → append ` --silent-debugger-extension-api` to the end of the
  **Target** field, after the closing quote of the `.exe` path:
  ```
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api
  ```
- **macOS** — launch from a terminal:
  ```bash
  open -a "Google Chrome" --args --silent-debugger-extension-api
  ```
- **Linux** — launch from a terminal:
  ```bash
  google-chrome --silent-debugger-extension-api
  ```

**The tradeoff.** The flag is global to that Chrome instance: it silences
the infobar for **every** extension using `chrome.debugger`, not just
browser-link — including any other debugger-API extension you happen to
have installed. Only reach for it once you understand and accept that
tradeoff. `browser-link doctor` reports, best-effort, whether a running
Chrome/Chromium process was launched with the flag, so you can confirm the
state of your own setup instead of guessing.

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

| Tool                     | Purpose                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `browser.navigate`       | Send a tab to a different URL (waits for load by default)                                                       |
| `browser.click`          | Click an element by CSS selector; hit-tests for occlusion first (`force:true` to bypass)                        |
| `browser.type`           | Focus an input and type text via the native value setter                                                        |
| `browser.press`          | Trusted CDP key press (+ modifiers) — real `isTrusted:true` input, for widgets synthetic events miss            |
| `browser.drag`           | Drag element→element or coordinate→coordinate; HTML5 or pointer-based, auto-detected                            |
| `browser.flow`           | Run a declarative find/click/type/press/wait_for/drag/sleep sequence in one round trip; fail-fast, max 20 steps |
| `browser.evaluate`       | Run an arbitrary JavaScript expression in the page and return its result                                        |
| `browser.dialog_respond` | Answer a pending native `alert` / `confirm` / `prompt` / `beforeunload` [^dialog-claim]                         |
| `browser.set_permission` | Pre-grant or pre-deny a browser permission (geo, notifications, camera, …) for an origin                        |
| `browser.claim_tab`      | Reserve a tab cooperatively for the calling agent (multi-agent mode)                                            |
| `browser.release_tab`    | Release a tab claim the calling agent holds                                                                     |
| `browser.reset`          | Soft-reset the bridge — drop tabs, claims and events; keep the server alive [^reset-global]                     |

[^dialog-claim]:
    `dialog_respond` deliberately bypasses the claim guard — a dialog
    freezes the tab's JS thread, and unblocking it should not require
    holding the claim. First responder wins.

[^reset-global]:
    `reset` is global — it takes no `tab_id` and touches no claim; it
    drops every tab, claim and event on the bridge at once.

`click` / `type` / `press` share a `settle_ms` option (see below). `find`,
`click`, `type`, `press`, `drag` (endpoint resolution only) and
`snapshot`/`state` all pierce open Shadow DOM roots and same-origin
iframes, nested arbitrarily.

### Behavior worth knowing before you rely on it

| Behavior                         | What to know                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shadow DOM / iframe piercing** | `snapshot`, `find`, `state`, `click`, `type`, `press` and `drag`'s selector endpoints reach into OPEN shadow roots and same-origin iframes, nested arbitrarily. They CANNOT reach CLOSED shadow roots (`attachShadow({mode:"closed"})`) or cross-origin iframes — there is no CDP-level workaround for either. A selector that matches structurally-identical twins across roots comes back with `ambiguous: true`; use it immediately and never cache it in the map. |
| **Occlusion guard**              | `browser.click` hit-tests the target's own click point before dispatching. If a different element covers that point, the call returns `ok:false` describing the blocker instead of clicking the wrong thing blindly. Pass `force:true` to bypass the guard intentionally.                                                                                                                                                                                             |
| **`near_misses`**                | When `browser.find` matches nothing, the response can carry up to 3 ranked candidates as hints for a follow-up `find` call — they are suggestions for re-finding, never selectors to click on directly.                                                                                                                                                                                                                                                               |
| **`browser.flow` recipes**       | The persistent map can store named, replayable flow recipes validated against the exact `browser.flow` step grammar, and the placeholder privacy rule that protects them — see [Persistent UI map](#persistent-ui-map).                                                                                                                                                                                                                                               |

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
- **Throttling is not settle's job either.** Settle returns as soon as
  the page stops mutating, so on an already-idle page it collapses to
  nothing. For a pause that is always spent in full — pacing repeated
  actions against a rate-limited backend — use a `sleep` step inside
  `browser.flow` (below).

#### `sleep` — the fixed pause, and why it is a flow step

A `{ sleep: { ms } }` step (1–30 000 ms) pauses the flow for exactly that
long. It exists because `settle_ms` structurally cannot serve as a
throttle, and because the alternative was worse: before it, the only way
to pace a repeated action was a loop inside `browser.evaluate`, where
every click becomes an untrusted `el.click()` — losing the occlusion
guard, pointer-events awareness and trusted CDP input that are the whole
point of the bridge. A `sleep` keeps all of that and still paces the
loop.

- It names no element, so it neither consumes nor sets the implicit
  target from a preceding `find` — a pending target survives it, exactly
  as it survives a `wait_for` or a `drag`.
- Its full `ms` counts against the flow's 60-second worst-case budget,
  because unlike a `wait_for` timeout (a ceiling it usually returns well
  under) a sleep is always spent in full.
- An out-of-range `ms` is **rejected, never clamped**. Silently halving a
  throttle would hit a rate-limited backend at twice the intended rate
  without ever saying so.

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

`browser.list_tabs` also surfaces the map directly: any tab whose origin
already has saved knowledge carries a `map` field (`{ app_key, entries,
flows }`). The usage protocol above instructs the agent to call
`browser.map.recall` for that origin BEFORE taking a fresh `browser.snapshot`
— no separate lookup needed to know memory already exists for that page.

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
the exact `browser.flow` step grammar (`find`/`click`/`type`/`press`/`wait_for`/`drag`/`sleep`)
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

### CLI: `browser-link map`

The six `browser.map.*` tools above are how an **agent** reads and writes
the map while it works. `browser-link map` is the same data from a
**human's** terminal — no agent required, useful for auditing what got
saved or pruning it after a refactor:

| Command                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `browser-link map`                               | Table of every known app: `app_key`, `origin`, entry/flow counts, last seen (relative time)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `browser-link map show <app>`                    | Full detail for one app — entries (kind, purpose, payload snippet, verified/failed) and flows (name, description, step count, use_count). `<app>` resolves by `app_key` or by origin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `browser-link map forget <app> --flow <name>`    | Delete one named flow recipe. The output names the resolved origin. No confirmation needed when `<app>` is unambiguous; if the same `app_key` exists on more than one origin, it prints which app it resolved to and asks for `--yes` (or pass the origin instead of the `app_key` to disambiguate)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `browser-link map forget <app> --yes`            | Delete a whole app and everything under it. **Without `--yes`**, prints what would be deleted and the exact command to confirm — nothing is touched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `browser-link map export [<app>] [--out <file>]` | Export the whole map, or one app, as JSON (`browser_link_map_export` version field for forward compat). Defaults to stdout, so it composes in a pipeline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `browser-link map import <file> [--replace]`     | Import an export. Default is a **merge**: apps upsert by canonical origin, flows upsert by name (a flow's `use_count` is never lowered), entries append and skip exact duplicates — each entry's `verified_at`/`failed_at` track record is preserved, never re-stamped. `--replace` deletes each imported app's existing data first. The WHOLE file is validated **before** anything is written — flow steps with the same rules `browser.flow` enforces, entry fields against the DB schema, a version check (newer exports are rejected cleanly), and sanity caps (500 apps / 5000 entries / 1000 flows per file, 1 MiB per payload) — any problem aborts the import with one aggregated report, inside a single transaction |

Not found → the error lists every known `app_key` so you don't have to
run `browser-link map` first to look one up.

> **Privacy note.** An export can carry UI structure and flow steps an
> agent saved — selectors, notes, multi-step recipes. Review a file before
> sharing it. The placeholder rule above means the map should never
> contain real domain data, but an export is only as clean as what an
> agent actually saved into it.

### Recording flows by demonstration

Instead of asking an agent to rediscover a multi-step UI path (open a
dialog, fill a form, submit), a human can **demonstrate it once** in a
connected tab and save the interaction directly as a named, replayable
`browser.flow` recipe — no agent involved in the capture at all.

**STRICTLY OPT-IN, off by default.** Nothing is ever recorded unless you
explicitly turn the feature on AND press Record on a specific tab.

**How to record:**

1. In the popup, check **"Enable flow recording"** (a settings toggle,
   same place and same persistence as the idle-disconnect TTL).
2. On an already-**connected** tab, the popup now shows a **Record**
   button. Press it and demonstrate the task: click things, type into
   fields, use keyboard navigation.
3. Press **Stop**. The popup shows a compact review — every captured step,
   in order.
4. Name the recipe (e.g. `"open task detail dialog"`) and press **Save**
   — or **Discard** to throw the capture away. Save sends the recipe to
   the server, which validates it with the exact same rules `browser.flow`
   itself enforces and writes it into the map's `flows` table (the same
   table `browser.map.save({ flows: [...] })` writes to). A validation
   failure (e.g. too many steps) is shown in the popup instead of silently
   vanishing.

**What gets captured** — v1 grammar, mapping 1:1 onto `browser.flow` step
kinds: a click becomes `{click:{selector}}`; typing into a field becomes
ONE `{type:{selector, text:"<TEXT>"}}` step per field, emitted when you
move on (blur / Enter / change) — **never per keystroke**; Escape/Tab/
arrow keys outside a text field become `{press:{key}}`; a navigation
triggered by a step inserts an editable `{wait_for:{expression:
"document.readyState === 'complete'"}}` suggestion. Capped at 20 steps —
recording auto-stops and the popup says so when the limit is hit. A step
whose selector could not be made unique across the page is flagged in the
review list (⚠ "may match multiple elements") and the caution is folded
into the saved recipe's description, so the signal follows the recipe.

**Privacy properties — verifiable, not just promised:**

- Recording is **off by default**; the setting lives in
  `chrome.storage.local` and is also editable via
  `browser-link config get/set flow-recording` (same last-write-wins
  precedence as idle-ttl — see [Idle-disconnect TTL](#idle-disconnect-ttl)
  above).
- Only ever **user-initiated, per tab**: the recorder script is injected
  via CDP `Runtime.evaluate` only after you press Record on that
  specific connected tab, and is removed (its listeners torn down
  in-page) the MOMENT recording stops — Stop, Discard, disconnect, tab
  removal, idle-disconnect, or the setting being turned off mid-recording
  all force this immediately.
- A `type` step's payload **structurally cannot** carry what you typed —
  there is no field for it. The placeholder string `"<TEXT>"` is the only
  value ever written, the same convention hand-written flow recipes
  already use for free text (see the placeholder privacy rule above).
  There is no keystroke-level listener anywhere in the recorder.
- Turning the popup toggle off stops recording instantly across every
  tab and **discards** whatever was captured so far — it does not sit
  around waiting to be saved.

**Threat model — safe to leave enabled while browsing arbitrary pages.**
The recorder reaches the extension through a CDP binding, and a CDP
binding is a global function reachable by EVERY script in the page (the
site's own code, ads, third-party widgets, an XSS payload). Several
layered defenses — not the review list — keep a hostile page from
fabricating or smuggling steps:

- **Per-session nonce + fully randomized globals.** Each recording start
  mints a fresh secret nonce and three independent random names for the
  recorder's in-page globals (the CDP binding, an idle flag, the teardown
  hook), all known only to the injected recorder. Every payload must carry
  the right nonce or the extension discards it before parsing — so a page
  script calling the binding blind records nothing. The global names are
  bare random identifiers with no shared prefix or suffix, so a page cannot
  cheaply scan `window` for a predictable pattern to detect that recording
  is active either.
- **Trusted events only.** Every recorder listener bails on
  `!event.isTrusted`, so events a page dispatches programmatically
  (`el.click()`, `dispatchEvent(new KeyboardEvent(...))`) are never
  captured. Tradeoff: page code that activates its own widgets via
  `.click()` during a demonstration is not captured either — reproduce
  the underlying real gesture.
- **Gesture correlation for typed fields.** `isTrusted` alone is not
  enough here: unlike `.click()`, a programmatic `element.focus()` /
  `.blur()` from page script DOES fire focus/blur events with
  `isTrusted:true`, so a hostile page could otherwise focus-then-blur an
  attacker-chosen input to fabricate a `type` step. A type step is
  therefore recorded only when the field's focus was driven by a real user
  gesture — a trusted pointerdown/mousedown that landed on the field, or a
  trusted key event on it while focused. A field that focuses and blurs
  with no such gesture is dropped.
- **Stricter-than-agent validation.** Recorder payloads are validated more
  tightly than agent-authored `browser.flow` steps: selectors are
  length-capped and rejected on control characters (C0/C1 controls, plus
  Unicode zero-width/bidi-override/format characters), so the channel
  cannot smuggle a cookie or token disguised as a selector into the map;
  and a `press` key must be on the exact recorder allowlist. The server
  also rejects a `flow.recorded` whose `tab_id` does not match the
  submitting connection, and caps the recipe name/description length.
- **Honest residual risk.** The nonce closes the realistic
  blind-injection hole; it does not defend against a script that can read
  the recorder closure's own variables — but any script with that power
  already fully owns the page. The gesture-correlation gate is defeated
  only in a much narrower way than the original zero-interaction bypass: a
  page that structurally wraps a real, user-clickable decoy _inside_ its
  target field can get that field "gestured" by a genuine click, then force
  the type-commit with a scripted blur — it still requires tricking the
  user into a real click on attacker-controlled layout, not a
  fully-silent fabrication. And the review list is a usability aid, not
  a security control: do not rely on eyeballing 20 steps to spot one
  fabricated entry — the nonce, the `isTrusted` gate, and the gesture
  correlation are what actually prevent fabricated entries from ever
  reaching the list.

**Known limitation.** Single-page-app route changes done purely via the
History API (`pushState`/`replaceState`, no full document load) do NOT get
an automatic `wait_for` navigation hint — detection is based on Chrome's
`tabs.onUpdated` "complete" signal, which History-API navigations don't
fire. Add a `wait_for` step by hand to the recipe if replay needs to wait
for such a transition.

**How agents replay a recorded flow:** exactly like any other saved
recipe — `browser.map.recall` returns it under `flows` (`name`,
`description`, `steps`, `use_count`); the agent adapts any `<TEXT>`
placeholder to the real value the task calls for, then calls
`browser.flow` with the adapted steps. No new MCP tool surface — recording
only changes how a recipe gets INTO the map, not how an agent gets it out.

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

## cdp-direct mode (no extension)

**Off by default.** An alternative, faster transport that lets the server
drive Chrome tabs **directly** over a Chrome launch flag
(`--remote-debugging-port`, default `9222`), skipping the extension
entirely — no `chrome.debugger` attach, no popup, no per-tab "Connect this
tab" click. Useful when you already run Chrome headless/remote-debuggable
for other tooling and do not want to also load the extension.

[Recording flows by demonstration](#recording-flows-by-demonstration) is
popup-only — with no popup on a `cdp:` tab, there is nothing to press
Record on, so recording does not apply to cdp-direct; replaying an
already-saved recipe with `browser.flow` works the same on both transports.

### The security tradeoff, plainly

The extension's model gives you two independent signals per tab: an
explicit click ("Connect this tab") **and** Chrome's own yellow
"started debugging this browser" infobar for as long as that tab is
attached (see the [FAQ above](#faq-the-yellow-started-debugging-this-browser-bar)).
cdp-direct has **neither** — once Chrome is listening on the debug port,
**any** page target on it is drivable, with no per-tab consent step and no
persistent on-tab indicator. That is a real reduction in transparency, not
a cosmetic one, which is why cdp-direct requires you to opt in at TWO
independent levels before any agent can touch it:

1. **The feature itself** — `cdp-direct.enabled`, off by default,
   `config.json`-persisted.
2. **A live, time-boxed grant** — a separate, short-lived permission you
   issue explicitly and that expires on its own (default 60 minutes,
   configurable, `never` allowed but discouraged).

An agent cannot flip either one — both are terminal-only commands. When a
tool call reaches a `cdp:` tab without both conditions met, it fails with
one of exactly two errors naming the missing step:

```
cdp-direct is disabled. The user can enable it with: browser-link config set cdp-direct.enabled true
cdp-direct requires an active grant. Ask the user to run: browser-link cdp allow
```

Two residual caveats worth stating plainly, in the same spirit as the
[security model](#security-model)'s "malware already inside Chrome" caveat:

- **Revoke does not interrupt a `browser.flow` already in progress.** The
  gate is checked at the START of every tool call, including a flow; a flow
  that has already begun runs its remaining steps to completion even if you
  revoke mid-flow. The exposure is bounded to that one flow's worst-case
  budget (**≤ 60 s** by the flow step-budget cap) — after it returns, the
  next tool call sees the revoked grant and is refused. Every other tool
  call re-checks the gate fresh, so revoke takes effect immediately for
  everything except an in-flight flow.
- **Port squatting.** browser-link verifies the debug endpoint is really
  Chrome (its `/json/version` `Browser` string must contain `"Chrome"`)
  before trusting anything on it — but a local process that manages to bind
  the debug port _before_ Chrome does could present that string and
  impersonate the endpoint. The blast radius is **data spoofing** (feeding
  the agent fake page content over loopback), not server RCE, and it
  requires an attacker who already has local code execution on your machine
  — the same precondition under which the extension transport's own
  process-binding check is likewise moot. Loopback-only binding means no
  remote party can reach the port regardless.

### Enable → allow → use → revoke

```bash
# 1. Launch Chrome with the remote-debugging port open (you do this — browser-link never launches Chrome).
google-chrome --remote-debugging-port=9222          # Linux
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222   # Windows
open -a "Google Chrome" --args --remote-debugging-port=9222                            # macOS

# 2. Turn the feature on (persists in config.json; still not usable without a grant).
browser-link config set cdp-direct.enabled true

# 3. Grant time-boxed access. Only you can run this — no agent can grant itself access.
browser-link cdp allow                    # uses cdp-direct.grant-ttl (default 60 min)
browser-link cdp allow --minutes 15       # a shorter one-off grant
browser-link cdp allow --minutes never    # never expires — reduces the security posture, see above

# 4. Check state at any time.
browser-link cdp status                   # enabled?, port, grant remaining, endpoint reachable?

# 5. Revoke whenever you want the door shut again.
browser-link cdp revoke
```

Once both conditions hold, `browser.list_tabs` also returns cdp-direct
page targets — real Chrome tabs, filtered to exclude `devtools://` and
`chrome-extension://` pages — with `tab_id` values shaped `cdp:<targetId>`
and `transport: "cdp"`, alongside your normal extension tabs (which keep
working exactly as before, unaffected). Claims, the persistent map's
origin-keyed hints, and every other cross-cutting feature work on a `cdp:`
tab the same as an extension tab.

```bash
browser-link config get cdp-direct.enabled | cdp-direct.port | cdp-direct.grant-ttl
browser-link config set cdp-direct.port 9333             # loopback port only — the host is always 127.0.0.1
browser-link config set cdp-direct.grant-ttl 15           # default TTL future `cdp allow` calls use
```

### v1 tool support

Every tool that reaches into page/JS content works identically over
cdp-direct — same in-page logic, same CDP commands (`Runtime.evaluate`,
`Input.dispatchMouseEvent`/`dispatchKeyEvent`, `Page.navigate`). A handful
of tools that depend on extension-only state (buffered console/network
history, canvas capture wiring, native permission grants, the popup's
dialog channel, or `window.open` tab-creation events) are explicitly out of
v1 scope and return a clear error naming the extension as the fallback.

| Supported in v1                                                                                                          | NOT supported in v1 (use the extension instead)                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `list_tabs`, `ping`, `snapshot`, `find`, `state`, `click`, `type`, `press`, `evaluate`, `wait_for`\*, `navigate`, `flow` | `console`, `network`, `network_body`, `canvas_screenshot`, `dialog_respond`, `set_permission`, `wait_for_tab`, `drag` |

\* `wait_for`'s `network_url` mode also falls back to "use the extension"
— cdp-direct does not buffer network requests, so there is nothing to poll
against. `selector` and `expression` modes are fully supported.

Claims apply to `cdp:` tab_ids through the same registry extension tabs
use. See the CHANGELOG's v0.23.0 entry for what a future v2 might add
(console/network mirroring, canvas capture, drag).

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

One deliberate tradeoff to state plainly: since v0.23.9 the extension
**auto-reconnects** after an involuntary drop — when a registered tab's
socket dies uncleanly (the primary MCP server crashed or restarted), it
retries the connection four times with backoff, over the exact same
channel a manual "Connect this tab" click uses, just without waiting for
a fresh human gesture. The server verifies the client's process; the
client never authenticates the server (a legitimately restarted primary
has no shared secret to present — that is what `tab-renamed` continuity
exists for), so during that bounded retry window a local process that
bound `127.0.0.1:17529` before the real server could accept the
reconnect. That attacker needs local code execution and a won loopback
port race — the same preconditions the "malware already inside Chrome"
caveat above and the cdp-direct port-squatting note already accept.
Explicit disconnects and `browser.reset` closes are deliberate goodbyes
and never auto-reconnect; past the fourth attempt the popup's Connect
button is the only way back.

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
├── docs/
│   └── specs/               # accepted multi-PR programs: contracts, acceptance, slice order
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
├── ROADMAP.md       # queued work, in priority order — pain / idea / cost / files
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
