# @jobshimo/browser-link

> ⚠️ **Read this before installing**
>
> This package opens a bridge between your MCP client (Claude Code,
> OpenCode, …) and the Chrome tabs you explicitly enable through a
> companion extension. On every tab where you press "Conectar" in the
> extension popup, the agent can read its DOM, click, type, run
> arbitrary JavaScript, and follow links — including any logged-in
> session, saved card, wallet, banking page or admin panel that tab is
> currently showing.
>
> Treat the agent like a junior dev with remote control of those tabs.
> Only enable tabs where you would let an automated process act on your
> behalf, and disconnect them when you are done. You are responsible for
> every action the agent performs on the tabs you explicitly enable.

MCP server that bridges any MCP-compatible client (Claude Code, OpenCode,
and friends) to the Chrome tabs you grant access to, through a small
WebSocket relay and a companion Chrome extension. Ships with a persistent
UI map so the agent remembers selectors, flows and gotchas it learned
about each app, across sessions.

## Install

```bash
npm install -g @jobshimo/browser-link
```

This puts the `browser-link` binary on your PATH on macOS, Linux and Windows.

## Set it up

The fastest path is the interactive menu (built on `@clack/prompts` —
flicker-free in PowerShell, Windows Terminal, macOS Terminal, iTerm, every
Linux TTY):

```bash
browser-link
```

That opens the welcome / disclaimer screen (English or Spanish), and then
the setup menu where you can register browser-link with **Claude Code** or
**OpenCode**, see the Chrome extension install steps, run a doctor
diagnose, and open the about / help page.

If you prefer direct commands:

```bash
browser-link install                       # register in every detected client
browser-link install --client claude       # register only in Claude Code
browser-link install --client opencode     # register only in OpenCode
browser-link uninstall --client opencode   # remove from one client
browser-link extension                     # show the Chrome extension assets path + steps
browser-link doctor                        # diagnose current setup
browser-link about                         # what this is, how it works, every tool
```

After `install`, restart the MCP client so it picks up the new entry.
After `extension`, follow the printed steps to load the unpacked extension
in Chrome. Then click "Conectar" on every tab you want the agent to reach
— and only on those.

## Supported MCP clients

| Client                                            | Config file written                                            |
| ------------------------------------------------- | -------------------------------------------------------------- |
| [Claude Code](https://docs.claude.com/claude-code) | `~/.claude.json` (`%USERPROFILE%\.claude.json` on Windows)     |
| [OpenCode](https://opencode.ai)                   | `~/.config/opencode/opencode.json` on **every** OS (Win incl.) |

Both registrations are idempotent — re-running `install` updates the
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
