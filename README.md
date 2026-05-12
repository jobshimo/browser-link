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

## Why

When an LLM agent works on a web app, the usual flow is: it reads code, it
reasons about what _should_ happen, but it never sees what the browser is
actually doing. `browser-link` closes that gap **without giving the agent
control of your whole browser** — the user enables specific tabs, one by
one, and disconnects them when they want.

Typical use cases:

- Reproduce a reported bug on a tab and verify it exists.
- Validate that a fix actually solved a bug, end-to-end, in the real UI.
- Give the agent real context (DOM, console, network) about what is
  happening in a view it is investigating.
- Persistent UI knowledge: the agent learns selectors, flows and gotchas
  for each app and remembers them across sessions.

## Quick start

```bash
npm install -g @jobshimo/browser-link
browser-link
```

That second command opens a full-screen interactive UI (English / Spanish)
built on top of [Ink](https://github.com/vadimdemedes/ink) — the same React-for-terminal
library that powers the Cloudflare Wrangler, Shopify CLI, AWS CDK and
GitHub Copilot CLI installers. Diff-rendered (no flicker), pinned header
with live client status, sub-screens that swap in place. Works in
PowerShell, Windows Terminal, macOS Terminal, iTerm and every Linux TTY:

```
╭─ browser-link — setup ──────────────────────────────────────────╮
│ Claude Code · registered   OpenCode · not registered            │
│ GitHub Copilot CLI · not detected                               │
│                                                                 │
│ Pick an action                                                  │
│                                                                 │
│ ❯ Register browser-link with an MCP client                      │
│   Permissions — pick which MCP tools to expose                  │
│   Show Chrome extension install steps                           │
│   Run doctor (diagnose current setup)                           │
│   Check for updates on npm                                      │
│   About / Help — what is this and how it works                  │
│   Open the GitHub repository                                    │
│   Quit                                                          │
│                                                                 │
│ ↑↓ navigate · ↵ select · l language · q quit                    │
╰─────────────────────────────────────────────────────────────────╯
```

It walks you through:

1. **Registering `browser-link` with your MCP client.** Pick **Claude Code**
   (writes `~/.claude.json` / `%USERPROFILE%\.claude.json`), **OpenCode**
   (writes `~/.config/opencode/opencode.json` on every OS, Windows included),
   or **GitHub Copilot CLI** (writes `~/.copilot/mcp-config.json`, override
   via `COPILOT_HOME`). Restart the client afterwards.
2. **Installing the Chrome extension.** Shows the absolute path to the
   bundled assets and the OS-specific steps (`chrome://extensions` →
   Developer mode → Load unpacked).
3. **A doctor command.** Reports what is and is not set up, per client,
   with live refresh.
4. **An About / Help page.** Full breakdown of every tool, where data is
   stored, and how the bridge works.

You can also use the subcommands directly without the menu:

```bash
browser-link install                       # register in every detected client
browser-link install --client claude       # register only in Claude Code
browser-link install --client opencode     # register only in OpenCode
browser-link install --client copilot      # register only in GitHub Copilot CLI
browser-link uninstall --client opencode   # remove from one client
browser-link extension                     # show extension assets path + steps
browser-link doctor                        # diagnose current setup
browser-link tools                         # show which MCP tools are enabled
browser-link tools disable browser.evaluate
browser-link tools preset readonly         # all | readonly | no-eval | no-map
browser-link updates                       # check the npm registry for a newer version
browser-link about                         # the full help page
browser-link help                          # list every subcommand
```

## Per-tool permissions

By default `browser-link` exposes 16 MCP tools — 10 to drive the connected
Chrome tab and 6 to read/write the persistent UI map. You can narrow that
down per machine:

- **In the menu**, pick "Permissions". Toggle individual tools with **Space**
  or apply a preset with **Enter**:
  - `All enabled` (default)
  - `Read-only` — no actions, no `evaluate`, no map writes
  - `No evaluate` — everything except arbitrary JS
  - `No persistent map` — bridge tools on, map tools off
    Press **s** to save.
- **From the shell**, the same controls are scriptable:
  ```bash
  browser-link tools                              # show current state
  browser-link tools disable browser.evaluate     # block JS execution
  browser-link tools preset readonly              # observation-only profile
  browser-link tools enable browser.click         # turn one back on
  ```

The deny list is stored in `config.json` next to the map DB. Changes take
effect the **next time the MCP client starts the server** (restart the
client to apply). Disabled tools are removed from `tools/list` and any
client that still tries to call them gets a clear error.

## Multi-agent mode (Claude + OpenCode + Copilot in parallel)

By default only one MCP client can have `browser-link` active at a time;
the second one to start gets a clear "port in use" error. Enable
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
secondary proxies lose the bridge. With `auto-reelect` enabled, the
proxies enter a 5-second reconnect window — requests in flight get a
clear `-32001 "temporarily unavailable"` envelope while the proxy waits
for the freshly-respawned primary (the MCP client of the primary will
respawn its server, racing to bind the WS port). When the new primary
appears, the proxy hot-swaps to it and traffic resumes.

**Traceability — `browser.events`**: every primary keeps an in-memory
ring buffer of bridge events (`primary-elected`, `tab-registered`,
`tab-disconnected`, `tab-renamed`) and exposes it through a new MCP
tool. When a tool call fails with "Tab not connected: tab_X" the error
message itself tells the agent to call `browser.events`, where a
`tab-renamed` entry maps the old id to the new one — so the agent
recovers on its own after a primary swap.

The Chrome extension cooperates: it remembers the last `browser-link`
tab_id per Chrome tab in `chrome.storage.session` and asks the new
primary to keep the same id on reconnect. The primary honours it when
free, otherwise emits the `tab-renamed` event.

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│  Your MCP client (Claude Code, OpenCode, Copilot CLI, …)         │
└──────────────────────┬───────────────────────────────────────────┘
                       │  stdio (MCP)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  browser-link MCP server (Node 22+)                              │
│  ─ listens on 127.0.0.1:17529  (loopback only)                   │
│  ─ exposes browser.* tools + browser.map.* persistent UI map     │
└──────────────────────┬───────────────────────────────────────────┘
                       │  WebSocket (loopback)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Chrome extension (Manifest V3, custom, ships with the package)  │
│  ─ inert by default                                              │
│  ─ activates per-tab when the user clicks "Conectar" in the      │
│    extension popup                                               │
│  ─ uses chrome.debugger (Chrome DevTools Protocol) under the hood│
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
                  Browser tab
              (only the connected ones)
```

Important details:

- The WebSocket bridge **only binds to `127.0.0.1`** — never on a public
  interface, never reachable from anywhere outside your machine.
- Tabs you do **not** explicitly connect remain invisible to the agent.
  You can connect as many as you want; each one is enabled one by one.
- Disconnecting a tab from the extension popup immediately revokes the
  bridge for that tab.

## 🧠 The agent learns your apps — and remembers across sessions

> **This is the feature that makes `browser-link` more than a remote
> control.** Every time the agent figures something out about a web app
> (where a button lives, which combination of events fires its handler,
> what gotcha tripped it the first time), it can persist that piece of
> knowledge in a **local SQLite database** under your user folder.
>
> Next session, the agent calls `browser.map.recall` and gets that
> knowledge back — instead of rediscovering the same selectors and
> flows from scratch every conversation.

### What gets remembered

The map stores three kinds of entries, indexed by `(app, route)`:

| Kind         | What it looks like                                                                   | When the agent saves it                                             |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **selector** | `{ selector: "button[aria-label='Save']", evidence?: "found via snapshot" }`         | A CSS selector tied to a stable purpose                             |
| **flow**     | `{ steps: [{action:'click', selector:'#chip'}, {action:'wait', ms:500}, …] }`        | An ordered sequence of actions that reaches an outcome end-to-end   |
| **gotcha**   | `{ body: "Synthetic dblclick does not fire the React handler — use full sequence" }` | A non-obvious fact about the app that would take time to rediscover |

Each entry has `verified_at` / `failed_at` timestamps so the agent knows
whether the saved knowledge is fresh, stale, or known-broken. When a
selector that used to work suddenly fails, the agent marks it via
`record_use({ ok: false })` and stops trusting it until it relearns.

### The loop, in plain English

```
┌──────────────────────────────────────────────────────────────────────┐
│  You ask:                                                            │
│     "Open the user detail dialog for user 42 and check the audit log"│
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
     ┌────────────────────────────────────────────────────────┐
     │  1) Agent calls browser.map.recall({ origin, url })    │
     │     → returns the selectors / flows / gotchas it has   │
     │       learned for this app + route in past sessions    │
     └────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
     ┌────────────────────────────────────────────────────────┐
     │  2) Agent reuses what it knows — saves time and tokens │
     │     If something is stale, it falls back to snapshot   │
     │     and re-learns. If it's wrong, it marks failed.     │
     └────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
     ┌────────────────────────────────────────────────────────┐
     │  3) Agent does the task and saves any new learning     │
     │     via browser.map.save({ kind, purpose, payload })   │
     │     so the next session starts even better-equipped.   │
     └────────────────────────────────────────────────────────┘
```

### Where the database lives

A single SQLite file (`map.db`) on your machine. **Nothing is ever
uploaded** — the bridge talks loopback only and the map never leaves
your laptop.

| OS      | Default path                                                                                |
| ------- | ------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/browser-link/map.db`                                         |
| Linux   | `$XDG_DATA_HOME/browser-link/map.db` <br/> _(default `~/.local/share/browser-link/map.db`)_ |
| Windows | `%APPDATA%\browser-link\map.db`                                                             |

Override with `BROWSER_LINK_DATA_DIR` if you want a portable install or
need to inspect the DB out-of-the-way.

### Schema, for the curious

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

The agent gets this protocol pushed automatically over the MCP
`initialize` handshake — you do not need to prompt-engineer it to
use the map. It just does.

## Tools exposed to the agent

The MCP server registers two families of tools.

**Browser bridge** — operate on a connected tab:

| Tool                   | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `browser.list_tabs`    | List tabs currently connected through the extension              |
| `browser.ping`         | Verify the bridge to a tab; returns its title and URL            |
| `browser.snapshot`     | Title, URL, visible text and interactive elements with selectors |
| `browser.navigate`     | Send a tab to a different URL                                    |
| `browser.click`        | Click an element by CSS selector                                 |
| `browser.type`         | Focus an input and type text                                     |
| `browser.evaluate`     | Run an arbitrary JavaScript expression in the page               |
| `browser.console`      | Rolling buffer of recent console messages (last 200)             |
| `browser.network`      | Rolling buffer of recent network requests (last 200)             |
| `browser.network_body` | Fetch the response body of a specific request                    |

**Persistent UI map** — local-only memory across sessions:

| Tool                     | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `browser.map.recall`     | Recall selectors / flows / gotchas known for an app+route |
| `browser.map.save`       | Persist a `selector`, `flow` or `gotcha`                  |
| `browser.map.record_use` | Mark an entry as freshly verified or failed               |
| `browser.map.forget`     | Delete an entry or an entire app                          |
| `browser.map.rename_app` | Fix an auto-derived app_key                               |
| `browser.map.apps`       | List known apps                                           |

On every MCP `initialize` handshake the server also pushes a short usage
protocol to the client (when to call `recall`, what kinds to save,
what _never_ to save) — no manual prompt configuration required.

## Security model

The WebSocket bridge binds to `127.0.0.1:17529` — loopback only, never on a
public interface. On top of that, before accepting any WebSocket handshake
the server asks the operating-system kernel **which process** opened the
incoming TCP connection. If the owning binary is not a known Chromium-based
browser (Chrome, Chromium, Edge, Brave, Vivaldi) the handshake is refused
with HTTP 403 before any application bytes are exchanged.

- **macOS / Linux** → `lsof` (`/proc/net/tcp` on Linux is enough too).
- **Windows** → `netstat -ano` + `tasklist`.

Concretely this means:

- ✔ Random local processes (curl, other Node scripts, scanners) cannot talk
  to the bridge even if they figured out the port.
- ✔ A process that crafts a fake `Origin: chrome-extension://...` header is
  still rejected: the kernel reports its real binary name.
- ✘ Malware that has already injected itself **inside Chrome** (via
  `chrome.debugger` from another extension, dylib injection, gdb attach…)
  passes the check. But that attacker already controls the browser
  directly — the bridge gives them nothing they did not already have.

The setup has **no tokens to paste**, **no manifests to register**, and
**no manual step beyond clicking "Conectar"** in the extension popup.
`browser-link doctor` lists the current allowlist on your OS.

## Where your data lives

The persistent map is a single SQLite file on **your machine**, never
uploaded:

| OS      | Path                                                                                        |
| ------- | ------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/browser-link/map.db`                                         |
| Linux   | `$XDG_DATA_HOME/browser-link/map.db` <br/> _(default `~/.local/share/browser-link/map.db`)_ |
| Windows | `%APPDATA%\browser-link\map.db`                                                             |

Override with `BROWSER_LINK_DATA_DIR`. The same directory also holds
`config.json` with UX preferences (e.g. dismissed welcome, chosen language).

Nothing in this package phones home. The WebSocket bridge talks loopback
only.

## Repository layout

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

## Contributing

This is an open project and contributions are welcome. Code is the
quickest way, but bug reports, repro cases, and ideas in the issue
tracker are just as useful.

- **Bug report or feature idea**: open an issue at
  [github.com/jobshimo/browser-link/issues](https://github.com/jobshimo/browser-link/issues).
- **Pull request**: fork the repo, branch from `main`, push, open a PR.
  All merges go through review.

### Development setup

Requires Node 22+ (any modern LTS / current works).

```bash
git clone https://github.com/jobshimo/browser-link.git
cd browser-link
npm install
npm run build
```

Useful scripts (run from the repo root):

| Script                    | What it does                                          |
| ------------------------- | ----------------------------------------------------- |
| `npm run build`           | Build the server and the Chrome extension             |
| `npm run build:server`    | Build only the server (`packages/server/dist/`)       |
| `npm run build:extension` | Build only the extension (`packages/extension/dist/`) |
| `npm run dev`             | Run the server in watch mode (recompiles on save)     |
| `npm run typecheck`       | Type-check every workspace, no emit                   |
| `npm run inspect`         | Launch the MCP Inspector wired to the local server    |
| `npm run generate:icons`  | Regenerate extension PNGs from `icons/icon.svg`       |
| `npm run clean`           | Remove every `dist/` directory                        |

> ### ⚠️ Important note on `npm run dev`
>
> `npm run dev` opens its own WebSocket on `127.0.0.1:17529` — the same
> port the registered MCP server uses. **Two processes cannot bind the
> same port at the same time.**
>
> So while you are developing locally:
>
> - If your MCP client (Claude Code, OpenCode, …) is open **and** has
>   `browser-link` registered, it already spawned the server and owns the
>   port. `npm run dev` will crash with `EADDRINUSE`.
> - If `npm run dev` is the one holding the port, the client's
>   `browser-link` MCP will fail to start (`✗ Failed to connect`).
>
> Recommended dev flow:
>
> 1. Quit the MCP client (or `kill` the `node …/dist/index.js` PID that
>    it spawned — find it with `lsof -iTCP:17529 -sTCP:LISTEN -nP`).
> 2. Now run `npm run dev` — port is free, tsx watch picks up your edits.
> 3. When you are done coding, stop `npm run dev` and reopen the MCP client
>    so it can spawn its own server again.
>
> `npm run build` (without watch) does **not** touch the port, so you can
> always rebuild while the client is open. Only the live `dev` server
> needs the port.

Architecture decisions are kept in [`DECISIONS.md`](./DECISIONS.md).

### Cutting a release

Releases never push commits straight to `main` — they always go through a
PR, so branch protection rules can stay as strict as you like (today and
tomorrow).

```bash
npm run release -- patch     # 0.5.2 → 0.5.3
npm run release -- minor     # 0.5.2 → 0.6.0
npm run release -- major     # 0.5.2 → 1.0.0
npm run release -- 0.5.3     # explicit version
```

What `scripts/release.mjs` does, in order:

1. Refuses to start unless your working tree is clean, you are on `main`,
   and `main` is in sync with `origin/main`.
2. Refuses to start unless every `version` field across the monorepo is
   already aligned (root `package.json`, each workspace `package.json`,
   `packages/extension/manifest.json`). Misalignment is treated as the
   user's call to fix manually before releasing.
3. Bumps every version field to the new number.
4. Runs `npm install --package-lock-only` so the lockfile matches.
5. Generates a CHANGELOG entry at the top of
   `packages/server/CHANGELOG.md` from conventional commits since the
   previous tag, grouped by section.
6. Commits the lot on a new branch `release/vX.Y.Z` with the message
   `chore(release): vX.Y.Z`.
7. Pushes the branch and opens a PR against `main` with the CHANGELOG
   entry in the body.

You then review the PR and merge it via the GitHub UI like any other.
After the merge, `.github/workflows/release-finalize.yml` watches `main`,
detects the `chore(release): vX.Y.Z` commit, creates the matching tag and
GitHub Release with the same notes. **npm publish stays manual**:

```bash
cd packages/server
npm publish
```

#### Optional: be reminded at push time

A pre-push hook can ask you whether to cut a release whenever
`origin/main` has accumulated conventional commits since the last tag.
Saying _no_ is a single Enter — the hook never blocks anything.

```bash
git config core.hooksPath .githooks
```

Run that once per clone. To opt out, run
`git config --unset core.hooksPath`.

## License

[MIT](./LICENSE) — © 2026 Martín Miguel Bernal
