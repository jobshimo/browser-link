# @jobshimo/browser-link

> ⚠️ **Read this before installing**
>
> **Important notice**
>
> browser-link is a development tool. It connects an AI agent to the Chrome tabs you choose, and in those tabs the agent acts with your own session: it sees and can use everything the browser holds in them, including active logins, cookies and tokens, autofilled passwords and payment cards, email, documents and any data the page shows or lets you submit. It can click, type, submit forms and download files as you would.
>
> Connect only tabs an agent should operate, disconnect them when you are done, and do not use it on sites whose terms forbid it or with data you cannot afford to expose. Deciding what to grant access to, and what the agent does with that access, is solely the user's responsibility.
>
> The software is provided "as is", without warranty of any kind, under the MIT license. The authors accept no liability for losses, damage or misuse arising from its use.
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

It exposes 40 MCP tools — 34 for driving the connected tab (read the DOM,
click, type, run JS, watch console/network, drive multi-step flows…) and 6
for a persistent UI map, a small local SQLite DB where the agent saves
selectors, flows and gotchas it learns about each app so it does not
rediscover them every session. Every tool is individually toggle-able, and
the whole thing runs loopback-only — nothing here talks to the network
except the npm registry update check (on `browser-link updates`, when the terminal UI opens and every six hours after, and when the Admin window asks for its state).

A `browser-link` CLI binary handles setup (register with your MCP client,
show the extension install steps, diagnose the current state) and, new in
this release, lets a human inspect and manage the persistent map directly
from a terminal — list known apps, read what was saved about one of them,
delete stale knowledge, or export/import it as JSON.

## Install

```bash
npm install -g @jobshimo/browser-link
```

This puts the `browser-link` binary on your PATH on macOS, Linux and Windows. CI runs on Windows and Linux; macOS is supported in code but no CI job runs on it, so its peer check is covered only by unit tests with a stubbed `lsof`.

### Windows: skip the npm shim for faster CLI calls

Each `browser-link …` call from PowerShell or cmd goes through npm's
`browser-link.cmd` / `browser-link.ps1` shim, which starts its own shell
before Node: that shim costs 0.7–3.7 s per call on Windows, not
browser-link. Call the installed CLI directly instead. Find the global
`node_modules` folder with `npm root -g` and add a function to your
PowerShell profile (`notepad $PROFILE`):

```powershell
# npm root -g printed e.g. C:\Users\you\AppData\Roaming\npm\node_modules
function browser-link { node "C:\Users\you\AppData\Roaming\npm\node_modules\@jobshimo\browser-link\dist\cli.js" @args }
```

In cmd, the same with a macro:
`doskey browser-link=node "<npm root -g>\@jobshimo\browser-link\dist\cli.js" $*`.
The function only changes your terminal: the MCP server your client starts
pays the shim once per session, not once per call.

## Quick start

The fastest path is the interactive UI — a full-screen [Ink](https://github.com/vadimdemedes/ink)-based app with a pinned header, live status of every MCP client, and sub-screens that swap in place:

```bash
browser-link
```

That opens the welcome screen and then a status view: the running server,
its ports, multi-agent, the instructions block per client, cdp-direct and
updates, with the setup menu's entries and hotkeys right below it (Tab opens
the full menu) to register with **Claude Code**, **OpenCode** or **GitHub
Copilot CLI**, see the Chrome extension install steps, run a doctor
diagnose, and manage per-tool permissions.

Or drive it directly:

```bash
browser-link install                       # register in every detected client
browser-link install --client claude       # register only in Claude Code
browser-link extension                     # show the Chrome extension assets path + steps
browser-link doctor                        # diagnose current setup (running vs installed version, live processes); every probe runs in parallel
browser-link stop                          # stop the browser-link server the OS confirms on the bridge port
browser-link tools                         # show which of the 40 MCP tools are enabled
browser-link tools preset readonly         # all | readonly | no-eval | no-map
browser-link map                           # list apps the persistent UI map knows about
browser-link instructions install          # write the short browser-link trigger into each client's global .md
browser-link feedback                      # what agents reported about browser-link itself
browser-link about                         # overview — what this is, how it works, every tool
browser-link help                          # list every subcommand
```

After `install`, restart your MCP client. After `extension`, load the
unpacked extension as instructed, then click "Connect this tab" on every
tab you want the agent to reach.

`browser-link stop` stops only what the operating system confirms: the holder
of the bridge port (17529) or the IPC port (17530) when it is a browser-link
server. It says "already free" only after a lookup that worked; a failed lookup
is reported as such and stops nothing. Other processes that only look like a
bridge are listed with their command and left running.
`browser-link stop --pid <PID>` shows one process and stops exactly that one;
it refuses a PID the operating system does not list, this command or its
ancestors, and a process that neither holds a browser-link port nor runs as a
browser-link server.

The command line is strict. `--opt value` and `--opt=value` mean the same.
`--help` or `-h` after any command prints that command's help and does nothing
else. An unknown, repeated or value-less option, or an extra word, makes the
command refuse, touch nothing and exit with code 2, saying what it did not
understand.

`install` and `uninstall` edit only the `browser-link` entry of the client's
config and keep the rest of the file byte for byte, line ends included. The
write is atomic and makes no backup copy. A config that is a symlink, is not
valid UTF-8, does not parse, has the wrong shape or repeats the key is refused
and left unchanged, with a message saying what was found. Without `--client`, both report every client. A client
that is refused shows `Refused, nothing written: <reason>` and does not stop
the others; the exit code is 1 when any client was refused. A replaced file
keeps its permission bits. `instructions
install` and `uninstall` do the same for the instructions file; one that is not
valid UTF-8, or has a begin marker with no end marker, is refused and left
unchanged. Install puts exactly one line end before the block (none into an
empty file); uninstall removes the block and, when it is last in the file, that
one line end, and nothing else.

## The 40 tools, at a glance

| Family                                 | Count | What it covers                                                                  |
| -------------------------------------- | ----: | ------------------------------------------------------------------------------- |
| Browser bridge — read                  |    17 | tabs, snapshot/find/state, console, network, wait_for(_tab), events, activity   |
| Browser bridge — actions               |    13 | navigate, click, type, press, drag, flow, dialogs, permissions, download, reset |
| Browser bridge — JS and knowledge loop |     4 | evaluate, read, wrap_up, feedback                                               |
| Persistent UI map                      |     6 | recall, save, record_use, forget, rename_app, apps                              |

Every tool can be disabled per machine via `browser-link tools disable
<name>` or a preset (`all` / `readonly` / `no-eval` / `no-map`). The full
tool-by-tool reference — every name, its exact contract, and the
Shadow-DOM/iframe piercing and occlusion rules the bridge tools follow —
lives in the [GitHub README](https://github.com/jobshimo/browser-link#what-the-agent-can-do);
this page stays a landing page on purpose.

Three things the page tools tell the agent are worth knowing here. A
`snapshot` or `find` result that was cut carries `truncated`, and `offset`
returns the rest. `snapshot` and `find` return the value of password fields
unless you run `browser-link config set hide-password-values on`. In the
activity trail, `browser-link config set activity.hide-sensitive <on|off>`
decides whether what was typed into a sensitive field is hidden in every column
of its row (it applies after a restart). The extension's Admin window shows
both settings but does not change them; see
[The activity trail](https://github.com/jobshimo/browser-link#the-activity-trail).

`browser.download` refuses executable file types (`.exe`, `.msi`, `.bat`,
`.ps1`, `.lnk`, `.js` and similar, also as `invoice.pdf.exe`) unless you run
`browser-link config set downloads.allow-executables on`; the Admin window only
shows that setting. On Windows every file it saves gets the Mark-of-the-Web
(the `Zone.Identifier` stream Chrome writes), so SmartScreen and Office
Protected View treat it as coming from the web; see
[Downloads](https://github.com/jobshimo/browser-link#downloads).

## `browser-link map` — inspect and manage the persistent map

The 6 map tools above are how an _agent_ reads and writes the map while it
works. `browser-link map` is how a _human_ looks at the same data from a
terminal, no agent required:

```bash
browser-link map                            # list every known app
browser-link map show <app>                 # entries + flows for one app (app_key or origin)
browser-link map forget <app> --yes         # delete a whole app and its data
browser-link map forget <app> --flow <name> # delete just one named flow
browser-link map export --out map.json      # back up the map as JSON
browser-link map import map.json            # restore it (merge by default, --replace to overwrite)
```

`map forget <app>` never deletes a whole app when the identifier matches more
than one: it lists the candidates and deletes nothing, with or without `--yes`.
The dry run's confirm command repeats the identifier you typed.

### The map learns by itself

Every click, type, press, find and wait_for an agent runs on a CSS selector
or a `browser.find` semantic key adds an ok or a failure (with a fixed reason
such as `not-found` or `retargeted`) to that target's counters, per app and
route. Agents see it as `learned` in `browser.map.recall` and in the
`list_tabs` map hint, failures first. **Targets only, never values**: typed
text, evaluate expressions and pressed keys are never read. At most 200
learned targets per app. On by default; `browser-link config set
map-learning off` stops it without a restart.

### What the map knows

Every learned record is keyed by origin and **path pattern** (`/facturas/48213`
→ `/facturas/:id`), stamped with the page's **build fingerprint** and **view
signature**, which `list_tabs` shows per tab as `build` and `view_sig`. Each
item the map offers carries `confidence` (`fresh` on this build, `unverified`,
or `failing` after 2+ structural failures on this build) plus its raw
evidence. `list_tabs` and `navigate` carry a ranked **start pack**,
`knowledge` (≤ 2 KB: pitfalls, mechanisms, kept readers, flows, best
selectors; failing ones only as `warnings`); `click`/`type`/`press`/`find`
carry `known` for a target with evidence; `browser.map.recall` with
`scope: "app"` or `"all"` returns the whole map.

For what went wrong in a session, agents call `browser.activity({ summary:
true })` and you run `browser-link activity report [--since <duration|iso>]
[--agent <id>]`: errors and flagged calls by flag, by tool, the top failing
selectors and one line per agent session.

> **Privacy note.** An export can contain UI structure and flow steps an
> agent saved — selectors, page notes, multi-step recipes. Review a file
> before sharing it. The map is designed so agents never write real domain
> data into it (IDs, names, dates — placeholders like `<QUERY>` stand in
> instead), but an export is only as clean as what was actually saved.

## Agent instructions — a trigger, the rules just in time

`browser-link instructions install` writes a short **trigger** (under 600
characters) between marker comments in each client's global instructions
file (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`,
`~/.copilot/AGENTS.md`): what browser-link is, when to use it, and that the
first browser tool call returns the rules. Sessions that never touch a
browser pay only for those few lines.

The **rules** (the core, under 2,000 characters) come back as a second text
block of the first browser tool call of each agent session, and lead the MCP
connect-time instructions. They keep only what changes a decision, each
with the failure it prevents: `list_tabs` first and read `knowledge`, an
`ok` is not proof, act on the last `ref`, try `find`/`read`/`flow({ name })`
before writing JS, downloads only through `browser.download`, call
`browser.wrap_up` before answering the user (a result's `pending_wrap_up: n`
counts what waits for it), and the eight curation rules the server enforces.
Everything else is one `browser.manual({ topic })` away.

`browser-link instructions install --with-core` keeps the rules in the
installed block too (trigger + core, about 2,700 characters). The block
records its mode in a marker comment, the start-time refresh of an outdated
block keeps that mode, and `browser-link instructions` shows it per client.
Running `install` without the flag goes back to the trigger only.

### `browser-link feedback`

When a tool returns something an agent did not expect, the agent records it
(`browser.feedback`, or the `feedback` field of `browser.wrap_up`). Agents
never open issues. `browser-link feedback [--limit <n>]` lists the entries,
newest first; `browser-link feedback issue <id>` prints a GitHub issue draft
(tool, observed, expected, origin, app build, date; secret-shaped text
redacted, no agent id) and creates it on `jobshimo/browser-link` with
`gh issue create` only after you type `y` in the console. Without a terminal
it prints the draft and creates nothing.

## Also inside

- **Supported clients**: Claude Code, OpenCode, GitHub Copilot CLI — see
  [Quick start](https://github.com/jobshimo/browser-link#quick-start) for
  exact config paths.
- **Multi-agent mode** (on by default): more than one MCP client can share
  the same bridge and map. `browser-link multi-agent` shows the current
  state; see [Multi-agent mode](https://github.com/jobshimo/browser-link#multi-agent-mode)
  for how it works.
- **Updates take effect by themselves**: a newer browser-link that starts
  displaces an older primary (it reads `GET /version` on the bridge port),
  `browser-link stop` stops the holder of the bridge port when the operating
  system confirms it is a browser-link server, `doctor` and `list_tabs`
  show "running X / installed Y", and the extension popup has a "Repair
  connection" button. `/version` answers only a loopback `Host` header
  (`127.0.0.1`, `localhost`, `[::1]`; anything else gets `403`) and
  reports `repairing` during a repair, so the successor waits up to 5 s for
  the port instead of deferring; a failed restart keeps the old server
  serving, and a step-down never targets the starting process or its
  ancestors. It also carries an optional `sessions`, the agent sessions
  using the primary. The console's Updates screen shows what an update will
  do and asks first, and stops a server only on Windows. See
  [Updating while a server is running](https://github.com/jobshimo/browser-link#updating-while-a-server-is-running).
- **Admin panel**: the console's status view and the extension popup's
  Admin section render the same server-built sections and labels (English
  or Spanish). Every change that writes to disk shows a one-line preview with
  a single-use code, and the server applies it only with that code; stopping or updating the server stays a
  console command. See
  [Admin panel](https://github.com/jobshimo/browser-link#admin-panel-console-and-popup).
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
