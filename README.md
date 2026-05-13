<div align="center">

# 🔗 browser-link

**Bridge your MCP client (Claude Code, OpenCode, GitHub Copilot CLI, …) to the Chrome tabs you explicitly enable.**

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
> press **"Conectar"** in the extension popup, the agent can read its DOM,
> click, type, run arbitrary JavaScript, and follow links — **including any
> logged-in session, saved card, wallet, banking page or admin panel that
> tab is currently showing**.
>
> Treat the agent like a junior dev with remote control of those tabs.
> Only enable tabs where you would let an automated process act on your
> behalf, and disconnect them when you are done. **You are responsible for
> every action the agent performs on the tabs you explicitly enable.**

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

An MCP server that lets your editor's agent see and act on a Chrome tab you
explicitly enable — without giving it your whole browser.

- ✅ **What it does** — exposes `browser.*` MCP tools (snapshot, click,
  evaluate, navigate…) and a persistent UI map so the agent learns your
  apps across sessions.
- ✅ **What it needs** — Node ≥ 22.13 and Chrome / Chromium / Edge / Brave
  / Vivaldi. No accounts, no telemetry, no outbound calls except `npm`
  when you run `Check for updates`.
- 🚫 **What it does NOT do** — touch tabs you have not pressed Connect on,
  send anything off your machine, persist domain data in the map
  (selectors and flows only).
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
   and press **Conectar** on the tab you want the agent to see.

```
╭─ browser-link — setup ──────────────────────────────────────────╮
│ Claude Code · registered   OpenCode · not registered            │
│ GitHub Copilot CLI · not detected                               │
│                                                                 │
│ Pick an action                                                  │
│                                                                 │
│ ❯ [r] Register browser-link with an MCP client                  │
│   [i] Agent instructions                                        │
│   [p] Permissions — pick which MCP tools to expose              │
│   [m] Multi-agent — let MCP clients share one bridge            │
│   [d] Doctor — diagnose current setup                           │
│   [u] Check for updates on npm                                  │
│   [f] Free port — stop a stuck browser-link holding 17529       │
│   [e] Chrome extension install steps                            │
│   [a] About / Help                                              │
│   [q] Quit                                                      │
│                                                                 │
│ ↑↓ navigate · ↵ select · a-z hotkey · l language · q quit       │
╰─────────────────────────────────────────────────────────────────╯
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
browser-link multi-agent enable            # let several MCP clients share one bridge
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
│  ─ activates per-tab when the user clicks "Conectar"             │
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
  if no tool call lands for 30 minutes, the extension parks the tab on
  its own and you re-press Connect when you want it back.

## Use cases

- Reproduce a reported bug on a tab and verify it exists.
- Validate that a fix actually solved a bug, end-to-end, in the real UI.
- Give the agent real context (DOM, console, network) about what is
  happening in a view it is investigating.
- Build incremental UI knowledge: the agent learns selectors, flows and
  gotchas for each app and remembers them across sessions.

## What the agent can do

The MCP server registers two families of tools.

**Browser bridge** — operate on a connected tab:

| Tool                   | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `browser.list_tabs`    | List tabs currently connected through the extension                |
| `browser.ping`         | Verify the bridge to a tab; returns its title and URL              |
| `browser.snapshot`     | Title, URL, visible text and interactive elements with selectors   |
| `browser.navigate`     | Send a tab to a different URL                                      |
| `browser.click`        | Click an element by CSS selector                                   |
| `browser.type`         | Focus an input and type text                                       |
| `browser.evaluate`     | Run an arbitrary JavaScript expression in the page                 |
| `browser.console`      | Rolling buffer of recent console messages (last 200)               |
| `browser.network`      | Rolling buffer of recent network requests (last 200)               |
| `browser.network_body` | Fetch the response body of a specific request                      |
| `browser.claim_tab`    | Claim a tab for the current agent (cooperative ownership)          |
| `browser.release_tab`  | Release a tab the current agent holds                              |
| `browser.my_tabs`      | List tabs currently claimed by the current agent                   |
| `browser.events`       | Read the primary's bridge-event ring buffer (recovery + audit)     |
| `browser.reset`        | Soft-reset bridge state (drop tabs + claims + events; keep server) |

**Persistent UI map** — local-only memory across sessions:

| Tool                     | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `browser.map.recall`     | Recall selectors / flows / gotchas known for an app+route |
| `browser.map.save`       | Persist a `selector`, `flow` or `gotcha`                  |
| `browser.map.record_use` | Mark an entry as freshly verified or failed               |
| `browser.map.forget`     | Delete an entry or an entire app                          |
| `browser.map.rename_app` | Fix an auto-derived app_key                               |
| `browser.map.apps`       | List known apps                                           |

On every MCP `initialize` handshake the server pushes a structured usage
protocol to the client (when to call `recall`, what kinds to save, what
to _never_ save) — no manual prompt engineering required.

## Persistent UI map

> Every time the agent figures something out about a web app (where a
> button lives, which combination of events fires its handler, what
> gotcha tripped it the first time), it can persist that knowledge in a
> **local SQLite database** under your user folder. Next session, the
> agent calls `browser.map.recall` and gets that knowledge back — instead
> of rediscovering the same selectors and flows from scratch every
> conversation. **This is what makes `browser-link` more than a remote
> control.**

### What gets remembered

Three kinds of entries, indexed by `(app, route)`:

| Kind         | What it looks like                                                                   | When the agent saves it                                             |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **selector** | `{ selector: "button[aria-label='Save']", evidence?: "found via snapshot" }`         | A CSS selector tied to a stable purpose                             |
| **flow**     | `{ steps: [{action:'click', selector:'#chip'}, {action:'wait', ms:500}, …] }`        | An ordered sequence of actions that reaches an outcome end-to-end   |
| **gotcha**   | `{ body: "Synthetic dblclick does not fire the React handler — use full sequence" }` | A non-obvious fact about the app that would take time to rediscover |

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
   returns selectors / flows / gotchas it learned for this app+route
         │
         ▼
2) Agent reuses what it knows — saves time and tokens
   stale entries fall back to snapshot and relearn; wrong ones get marked
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
```

## Customising

Three knobs, all opt-in, all reversible.

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

By default `browser-link` exposes 16 MCP tools — 10 to drive the
connected Chrome tab and 6 to read/write the persistent UI map. You can
narrow that down per machine:

- **In the menu** → `Permissions`. Toggle individual tools with **Space**
  or apply a preset with **Enter** (`all` / `readonly` / `no-eval` /
  `no-map`). Press **s** to save.
- **From the shell**:

```bash
browser-link tools                              # current state
browser-link tools disable browser.evaluate     # block JS execution
browser-link tools preset readonly              # observation-only profile
browser-link tools enable browser.click         # turn one back on
```

The deny list lives in `config.json` next to the map DB. Changes are
**live**: the server re-reads the file on every `tools/list` and
`tools/call`, so toggles take effect on the agent's next tool call — no
MCP client restart needed.

### Multi-agent mode

By default only one MCP client can have `browser-link` active at a
time; the second to start gets a clear "port in use" error. Enable
multi-agent mode and a second `browser-link` spawn becomes a thin proxy
that forwards MCP requests to the first one over an internal IPC port:

```bash
browser-link multi-agent enable
browser-link multi-agent auto-reelect enable     # optional, see below
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

## Security model

The WebSocket bridge binds to `127.0.0.1:17529` — loopback only, never
on a public interface. On top of that, before accepting any WebSocket
handshake the server asks the operating-system kernel **which process**
opened the incoming TCP connection. If the owning binary is not a known
Chromium-based browser (Chrome, Chromium, Edge, Brave, Vivaldi) the
handshake is refused with HTTP 403 before any application bytes are
exchanged.

- **macOS / Linux** → `lsof` (`/proc/net/tcp` on Linux is enough too).
- **Windows** → `netstat -ano` + `tasklist`.

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
clicking "Conectar" in the extension popup. `browser-link doctor` lists
the current allowlist on your OS.

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
`config.json` (UX preferences) and `multi-agent-token` (rotated at
every primary startup).

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
├── packages/
│   ├── server/      # MCP server + CLI binary published as @jobshimo/browser-link
│   ├── extension/   # Manifest V3 Chrome extension, bundled into the npm tarball
│   └── shared/      # workspace-internal type-only package
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

| Script                     | What it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `pnpm run build`           | Build the server and the Chrome extension             |
| `pnpm run build:server`    | Build only the server (`packages/server/dist/`)       |
| `pnpm run build:extension` | Build only the extension (`packages/extension/dist/`) |
| `pnpm run dev`             | Run the server in watch mode (recompiles on save)     |
| `pnpm run try`             | Run the TUI directly from source via `tsx`            |
| `pnpm run typecheck`       | Type-check every workspace, no emit                   |
| `pnpm run inspect`         | Launch the MCP Inspector wired to the local server    |
| `pnpm run generate:icons`  | Regenerate extension PNGs from `icons/icon.svg`       |
| `pnpm run clean`           | Remove every `dist/` directory                        |

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
