# @jobshimo/browser-link

> ⚠️ **Read this before installing**
>
> This package opens a bridge between your MCP client (Claude Code,
> OpenCode, GitHub Copilot CLI…) and the Chrome tabs you explicitly
> enable through a companion extension. On every tab where you press
> "Conectar" in the extension popup, the agent can read its DOM, click,
> type, run arbitrary JavaScript, and follow links — including any
> logged-in session, saved card, wallet, banking page or admin panel
> that tab is currently showing.
>
> Treat the agent like a junior dev with remote control of those tabs.
> Only enable tabs where you would let an automated process act on your
> behalf, and disconnect them when you are done. You are responsible for
> every action the agent performs on the tabs you explicitly enable.

MCP server that bridges any MCP-compatible client (Claude Code, OpenCode,
GitHub Copilot CLI, and friends) to the Chrome tabs you grant access to,
through a small WebSocket relay and a companion Chrome extension. Ships
with a persistent UI map so the agent remembers selectors, flows and
gotchas it learned about each app, across sessions.

## Install

```bash
npm install -g @jobshimo/browser-link
```

This puts the `browser-link` binary on your PATH on macOS, Linux and Windows.

## Set it up

The fastest path is the interactive UI — a full-screen [Ink](https://github.com/vadimdemedes/ink)-based app with a pinned header, live status of every MCP client, and sub-screens that swap in place (no flicker, no scroll-off):

```bash
browser-link
```

That opens the welcome / disclaimer screen (English or Spanish), and then
the setup menu where you can register `browser-link` with **Claude Code**,
**OpenCode**, or **GitHub Copilot CLI**, see the Chrome extension install
steps, run a doctor diagnose, and open the about / help page.

If you prefer direct commands:

```bash
browser-link install                       # register in every detected client
browser-link install --client claude       # register only in Claude Code
browser-link install --client opencode     # register only in OpenCode
browser-link install --client copilot      # register only in GitHub Copilot CLI
browser-link uninstall --client opencode   # remove from one client
browser-link extension                     # show the Chrome extension assets path + steps
browser-link doctor                        # diagnose current setup
browser-link tools                         # show which MCP tools are enabled / disabled
browser-link tools disable browser.evaluate
browser-link tools preset readonly         # all | readonly | no-eval | no-map
browser-link updates                       # check the npm registry for a newer version
browser-link about                         # what this is, how it works, every tool
```

## Per-tool permissions

`browser-link` exposes 17 MCP tools by default — 10 browser-bridge tools,
6 UI-map tools, and `browser.events` for bridge traceability. You can
disable any subset per machine, either through the **Permissions** screen
in the interactive menu (toggle with Space, apply a preset with Enter,
save with `s`) or through the scriptable `browser-link tools` subcommand.
Available presets: `all` (default), `readonly`, `no-eval`, `no-map`.
Changes take effect the next time your MCP client starts the server.

## Multi-agent mode

By default only one MCP client can have browser-link active at a time
(EADDRINUSE on the second). Enable multi-agent mode and the second
`browser-link` spawn becomes a proxy that forwards MCP requests to the
first via `127.0.0.1:17530`, with the same kernel-level process binding
the WS port already uses. All connected clients share the same Chrome
tabs and persistent UI map.

```bash
browser-link multi-agent enable
browser-link multi-agent auto-reelect enable     # optional
```

With `auto-reelect` on, secondary proxies survive the primary closing:
they enter a 5-second reconnect window, return `-32001 "temporarily
unavailable"` for in-flight requests, and hot-swap to the fresh primary
once it appears. The agent self-recovers from stale tab ids via the new
`browser.events` tool, which surfaces a ring buffer of bridge lifecycle
events (`primary-elected`, `tab-registered`, `tab-disconnected`,
`tab-renamed`). The Chrome extension preserves the per-tab id across
primary swaps via `chrome.storage.session`.

After `install`, restart the MCP client so it picks up the new entry.
After `extension`, follow the printed steps to load the unpacked extension
in Chrome. Then click "Conectar" on every tab you want the agent to reach
— and only on those.

## Supported MCP clients

| Client                                                               | Config file written                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Claude Code](https://docs.claude.com/claude-code)                   | `~/.claude.json` (`%USERPROFILE%\.claude.json` on Windows)       |
| [OpenCode](https://opencode.ai)                                      | `~/.config/opencode/opencode.json` on **every** OS (Win incl.)   |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/copilot-cli) | `~/.copilot/mcp-config.json` (override via `COPILOT_HOME` env)   |

Every registration is idempotent — re-running `install` updates the
entry instead of duplicating it. `uninstall --client <id>` removes it
cleanly without touching anything else in the file.

## Tools exposed

Browser bridge: `browser.list_tabs`, `browser.ping`, `browser.navigate`,
`browser.snapshot`, `browser.click`, `browser.type`, `browser.evaluate`,
`browser.console`, `browser.network`, `browser.network_body`.

UI map (persistent across sessions): `browser.map.recall`,
`browser.map.save`, `browser.map.record_use`, `browser.map.forget`,
`browser.map.rename_app`, `browser.map.apps`.

The server also ships usage instructions for the agent via the MCP
`initialize` handshake — no manual prompt setup required.

## Where the data lives

```
macOS    ~/Library/Application Support/browser-link/map.db
Linux    $XDG_DATA_HOME/browser-link/map.db   (default: ~/.local/share/browser-link/map.db)
Windows  %APPDATA%/browser-link/map.db
```

Override with `BROWSER_LINK_DATA_DIR`. The database is local to your
machine and never uploaded anywhere by this package. The WebSocket relay
binds to `127.0.0.1:17529` (loopback only).

## License

MIT — see [LICENSE](https://github.com/jobshimo/browser-link/blob/main/LICENSE).
