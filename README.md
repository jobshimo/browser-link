<div align="center">

# 🔗 browser-link

**Bridge Claude Code to the Chrome tabs you explicitly enable.**

[![npm version](https://img.shields.io/npm/v/@jobshimo/browser-link.svg)](https://www.npmjs.com/package/@jobshimo/browser-link)
[![npm downloads](https://img.shields.io/npm/dm/@jobshimo/browser-link.svg)](https://www.npmjs.com/package/@jobshimo/browser-link)
[![license](https://img.shields.io/npm/l/@jobshimo/browser-link.svg)](./LICENSE)
[![issues](https://img.shields.io/github/issues/jobshimo/browser-link.svg)](https://github.com/jobshimo/browser-link/issues)

</div>

---

> ### ⚠️ Read this before installing
>
> `browser-link` opens a bridge between Claude Code and the Chrome tabs you
> explicitly enable through a companion extension. On every tab where you
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

That second command opens an interactive setup menu (English / Spanish):

```
╭─────────────────────────────────────────────────────────────╮
│ browser-link — setup                                        │
│                                                             │
│ ❯ Register browser-link in Claude Code                      │
│     (status: not registered)                                │
│   Show Chrome extension install steps                       │
│   Run doctor (diagnose current setup)                       │
│   Show welcome screen                                       │
│   About / Help — what is this and how it works              │
│   Open the GitHub repository                                │
│   Quit                                                      │
│                                                             │
│ ↑/↓ to move, Enter to select, q to quit                     │
╰─────────────────────────────────────────────────────────────╯
```

It walks you through:

1. **Registering `browser-link` with Claude Code.** Writes the MCP entry to
   `~/.claude.json` (or `%USERPROFILE%\.claude.json` on Windows). Restart
   Claude Code afterwards.
2. **Installing the Chrome extension.** Shows the absolute path to the
   bundled assets and the OS-specific steps (`chrome://extensions` →
   Developer mode → Load unpacked).
3. **A doctor command.** Reports what is and is not set up.
4. **An About / Help page.** Full breakdown of every tool, where data is
   stored, and how the bridge works.

You can also use the subcommands directly without the menu:

```bash
browser-link install     # register in Claude Code
browser-link extension   # show extension assets path + steps
browser-link doctor      # diagnose current setup
browser-link about       # the full help page
browser-link help        # list every subcommand
```

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Code (or any MCP-compatible client)                      │
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
> - If Claude Code is open **and** has `browser-link` registered as an MCP,
>   Claude already spawned the server and owns the port. `npm run dev`
>   will crash with `EADDRINUSE`.
> - If `npm run dev` is the one holding the port, Claude Code's
>   `browser-link` MCP will fail to start (`✗ Failed to connect`).
>
> Recommended dev flow:
>
> 1. Quit Claude Code (or `kill` the `node …/dist/index.js` PID that
>    Claude spawned — find it with `lsof -iTCP:17529 -sTCP:LISTEN -nP`).
> 2. Now run `npm run dev` — port is free, tsx watch picks up your edits.
> 3. When you are done coding, stop `npm run dev` and reopen Claude Code
>    so it can spawn its own server again.
>
> `npm run build` (without watch) does **not** touch the port, so you can
> always rebuild while Claude Code is open. Only the live `dev` server
> needs the port.

Architecture decisions are kept in [`DECISIONS.md`](./DECISIONS.md).

## License

[MIT](./LICENSE) — © 2026 Martín Miguel Bernal
