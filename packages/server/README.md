# @jobshimo/browser-link

> ⚠️ **Read this before installing**
>
> This package opens a bridge between your MCP client (Claude Code,
> OpenCode, GitHub Copilot CLI…) and the Chrome tabs you explicitly
> enable through a companion extension. On every tab where you press
> "Connect this tab" in the extension popup, the agent can read its DOM, click,
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
through a small WebSocket relay and a companion Chrome extension. Only
tabs you explicitly connect are ever reachable; everything else stays
invisible to the agent.

It exposes 31 MCP tools — 25 for driving the connected tab (read the DOM,
click, type, run JS, watch console/network, drive multi-step flows…) and 6
for a persistent UI map, a small local SQLite DB where the agent saves
selectors, flows and gotchas it learns about each app so it does not
rediscover them every session. Every tool is individually toggle-able, and
the whole thing runs loopback-only — nothing here talks to the network
except the npm registry, on `browser-link updates`.

A `browser-link` CLI binary handles setup (register with your MCP client,
show the extension install steps, diagnose the current state) and, new in
this release, lets a human inspect and manage the persistent map directly
from a terminal — list known apps, read what was saved about one of them,
delete stale knowledge, or export/import it as JSON.

## Install

```bash
npm install -g @jobshimo/browser-link
```

This puts the `browser-link` binary on your PATH on macOS, Linux and Windows.

## Quick start

The fastest path is the interactive UI — a full-screen [Ink](https://github.com/vadimdemedes/ink)-based app with a pinned header, live status of every MCP client, and sub-screens that swap in place:

```bash
browser-link
```

That opens the welcome screen and then a setup menu to register with
**Claude Code**, **OpenCode** or **GitHub Copilot CLI**, see the Chrome
extension install steps, run a doctor diagnose, and manage per-tool
permissions.

Or drive it directly:

```bash
browser-link install                       # register in every detected client
browser-link install --client claude       # register only in Claude Code
browser-link extension                     # show the Chrome extension assets path + steps
browser-link doctor                        # diagnose current setup
browser-link tools                         # show which of the 31 MCP tools are enabled
browser-link tools preset readonly         # all | readonly | no-eval | no-map
browser-link map                           # list apps the persistent UI map knows about
browser-link about                         # overview — what this is, how it works, every tool
browser-link help                          # list every subcommand
```

After `install`, restart your MCP client. After `extension`, load the
unpacked extension as instructed, then click "Connect this tab" on every
tab you want the agent to reach.

## The 31 tools, at a glance

| Family                    | Count | What it covers                                                                    |
| -------------------------- | ----: | ----------------------------------------------------------------------------------- |
| Browser bridge — read      |    13 | list/claim tabs, snapshot/find/state, console, network, wait_for(_tab), events     |
| Browser bridge — actions   |    12 | navigate, click, type, press, drag, flow, evaluate, dialogs, permissions, reset    |
| Persistent UI map          |     6 | recall, save, record_use, forget, rename_app, apps                                 |

Every tool can be disabled per machine via `browser-link tools disable
<name>` or a preset (`all` / `readonly` / `no-eval` / `no-map`). The full
tool-by-tool reference — every name, its exact contract, and the
Shadow-DOM/iframe piercing and occlusion rules the bridge tools follow —
lives in the [GitHub README](https://github.com/jobshimo/browser-link#what-the-agent-can-do);
this page stays a landing page on purpose.

## `browser-link map` — inspect and manage the persistent map

The 6 map tools above are how an *agent* reads and writes the map while it
works. `browser-link map` is how a *human* looks at the same data from a
terminal, no agent required:

```bash
browser-link map                            # list every known app
browser-link map show <app>                 # entries + flows for one app (app_key or origin)
browser-link map forget <app> --yes         # delete a whole app and its data
browser-link map forget <app> --flow <name> # delete just one named flow
browser-link map export --out map.json      # back up the map as JSON
browser-link map import map.json            # restore it (merge by default, --replace to overwrite)
```

> **Privacy note.** An export can contain UI structure and flow steps an
> agent saved — selectors, page notes, multi-step recipes. Review a file
> before sharing it. The map is designed so agents never write real domain
> data into it (IDs, names, dates — placeholders like `<QUERY>` stand in
> instead), but an export is only as clean as what was actually saved.

## Also inside

- **Supported clients**: Claude Code, OpenCode, GitHub Copilot CLI — see
  [Quick start](https://github.com/jobshimo/browser-link#quick-start) for
  exact config paths.
- **Multi-agent mode** (on by default): more than one MCP client can share
  the same bridge and map. `browser-link multi-agent` shows the current
  state; see [Multi-agent mode](https://github.com/jobshimo/browser-link#multi-agent-mode)
  for how it works.
- **cdp-direct mode** (off by default): an extension-free transport gated
  behind `browser-link config set cdp-direct.enabled true` PLUS a
  time-boxed `browser-link cdp allow` grant — see
  [cdp-direct mode](https://github.com/jobshimo/browser-link#cdp-direct-mode-no-extension)
  for the security tradeoff and the v1 tool-support table.

## Where the data lives

```
macOS    ~/Library/Application Support/browser-link/map.db
Linux    $XDG_DATA_HOME/browser-link/map.db   (default: ~/.local/share/browser-link/map.db)
Windows  %APPDATA%/browser-link/map.db
```

Override with `BROWSER_LINK_DATA_DIR`. The database is local to your
machine and never uploaded anywhere by this package. The WebSocket relay
binds to `127.0.0.1:17529` (loopback only).

## Learn more

The [GitHub README](https://github.com/jobshimo/browser-link#readme) has
the full picture: every tool's contract, multi-agent mode, the "how it
works" architecture diagram, supported MCP clients, and the FAQ on
Chrome's debugger infobar.

## License

MIT — see [LICENSE](https://github.com/jobshimo/browser-link/blob/main/LICENSE).
