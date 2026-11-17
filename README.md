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
> **Important notice**
>
> browser-link is a development tool. It connects an AI agent to the Chrome tabs you choose, and in those tabs the agent acts with your own session: it sees and can use everything the browser holds in them, including active logins, cookies and tokens, autofilled passwords and payment cards, email, documents and any data the page shows or lets you submit. It can click, type, submit forms and download files as you would.
>
> Connect only tabs an agent should operate, disconnect them when you are done, and do not use it on sites whose terms forbid it or with data you cannot afford to expose. Deciding what to grant access to, and what the agent does with that access, is solely the user's responsibility.
>
> The software is provided "as is", without warranty of any kind, under the MIT license. The authors accept no liability for losses, damage or misuse arising from its use.
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
- [Upgrading to 1.0](#upgrading-to-10)
- [How it works](#how-it-works)
- [Use cases](#use-cases)
- [What the agent can do](#what-the-agent-can-do)
- [Persistent UI map](#persistent-ui-map)
- [Activity trail](#activity-trail)
- [Customising](#customising)
- [cdp-direct mode (no extension)](#cdp-direct-mode-no-extension)
- [Stability](#stability)
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

- ✅ **What it does** — exposes **40** MCP tools: 34 `browser.*` bridge tools
  (list_tabs, ping, snapshot, find, state,
  canvas_screenshot, screenshot, click, type, press, drag, flow, flow_cancel, flow_status, navigate, evaluate, read,
  wait_for, wait_for_tab, dialog_respond, set_permission, download, console,
  network, network_body, claim/release/my_tabs, events, activity, reset, wrap_up, feedback, and `manual`, which needs no tab) and 6
  persistent-map tools, so the agent learns your apps across sessions.
- ✅ **What it needs** — Node ≥ 22.22.2 and Chrome / Chromium / Edge / Brave
  / Vivaldi on Chromium ≥ 118 (from 118 an active debugger session keeps the
  extension's service worker alive; the manifest declares it). CI runs on Windows
  and Linux. macOS is supported in code, but no CI job runs on it: its peer
  check is covered by unit tests with an injected platform and a stubbed
  `lsof`, never by a real run. No accounts, no
  telemetry. The only request the server makes
  by itself is the npm registry update check described under
  [Where your data lives](#where-your-data-lives).
- 🚫 **What it does NOT do** — touch tabs you have not pressed Connect on,
  persist domain data in the map (selectors and flows only, structure never
  content). Beyond the update check, the only network traffic it causes is
  what you ask for: `browser.download` fetches the URLs the agent requests.
- 🔒 **How it stays private** — WebSocket bridge is loopback-only
  (`127.0.0.1:17529`) and kernel-attested per connection.
- 🛑 **How you stop it** — the extension popup lists every running
  `browser.flow` with a one-click **Stop**, across every connected tab.
  See [the Flows panel](#the-flows-panel).

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
   The extension carries a fixed public key, so its id is the same on every
   install, and the server accepts only that id (see
   [Upgrading to 1.0](#upgrading-to-10)). After updating the server, reload the
   extension in `chrome://extensions`.
4. **Connect a tab.** Click the browser-link icon in your Chrome toolbar
   and press **Connect this tab** on the tab you want the agent to see.
   The extension speaks English and Spanish (see
   [Extension language](#extension-language)).

After the first run, `browser-link` opens on a **status view**: the running
server (version, PID, uptime, ports, outdated or not), multi-agent, the
instructions block per client, cdp-direct, updates and the activity trail,
with every menu entry and its usual hotkey right below it. **Tab** opens the
full menu; every other screen still returns to the menu, as before. When no
server is running the status rows say so: the console reads the running
primary's `GET /version`, it never starts one.

#### The Flows panel

The same popup is where you watch — and stop — what the agent is doing.
While any `browser.flow` is running, a **Flows** section appears:

- **Running flows** — one row per in-flight flow, across **every**
  connected tab (a runaway flow is rarely on the tab you happen to be
  looking at): the tab's title, how long it has been going, where it is
  (`step 3/7`, or `step 2/5 · iteration 12/50` inside a `repeat`), and a
  **Stop** button. One click, no confirmation. The row reads
  `Stopping…` for the moment it takes the runner to reach its next step
  check. A [detached](#detached-execution--flow_status--flow_cancel) flow
  is labelled `detached ·` and gets an amber dot instead of a green one:
  it is the one row that will keep going with no agent attached, so it is
  the one row that most needs the button next to it.
- **Recent flows** — the last 20 finished flows **of the tab you are
  looking at**: outcome (`completed` / `cancelled` / `failed` /
  `expired`), how long it took, how many steps or iterations it got
  through, and which step failed when one did. A detached run that hit
  its 30-minute ceiling reads `expired`; one that Chrome killed the
  service worker under reads
  `failed · extension worker was terminated — not resumed`.

Both are hidden entirely when there is nothing running and nothing
remembered, so an idle popup looks exactly as it did before.

History lives in `chrome.storage.session` and **dies with the browser
session by design** — this is an operator view, not an audit log. Entries
store UI structure and outcomes only: counts, durations, a step index and
a step kind. Never page text, never a selector, never anything you typed.
Failure messages in particular are dropped rather than trimmed, because a
real `find` failure quotes the page back at you.

<!-- screenshot placeholder: the popup's Flows panel — one running flow
     with its Stop button, and two entries under Recent flows.
     TODO: capture at 320px width and add as docs/images/popup-flows.png -->

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
browser-link doctor                        # diagnose current setup (running vs installed version, live processes); every probe runs in parallel
browser-link tools                         # show which MCP tools are enabled
browser-link tools disable browser.evaluate
browser-link tools preset readonly         # all | readonly | no-eval | no-map
browser-link config get                    # list every known setting
browser-link config set idle-ttl 15        # idle-disconnect TTL, in minutes ("never" disables it); console only
browser-link config set claim-ttl never    # how long a claim between agents lasts idle (10 min by default); console only
browser-link config set flow-recording on  # opt in to recording flows by demonstration (off by default)
browser-link config set cdp-direct.enabled true  # opt in to cdp-direct mode (off by default, see below)
browser-link config set map-learning off  # stop the map learning from use (on by default, see below)
browser-link config set hide-password-values on  # snapshot and find show "filled, N characters" for password fields (off by default)
browser-link config set activity.hide-sensitive off  # store sensitive trail rows unhidden (on in this version; applies after a restart)
browser-link config set downloads.allow-executables on  # let browser.download save .exe, .msi, .bat, .ps1, ... (refused by default)
browser-link config restore-defaults --yes # only when config.json cannot be read: keep a copy, write the defaults
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
browser-link stop                          # stop the browser-link server the OS confirms on the bridge port; stop --pid <PID> stops one process
browser-link updates                       # check the npm registry for a newer version
browser-link about                         # the full help page
browser-link help                          # list every subcommand
```

`browser-link version` prints the version and returns at once: it does not
load the config, so a corrupt config never warns there.

**The command line is strict.** `--opt value` and `--opt=value` mean the same
everywhere. `--help` or `-h` after any command prints that command's help and
does nothing else. An unknown option, a repeated option, an option without its
value or an extra word makes the command refuse: it touches nothing, says what
it did not understand and exits with code 2. `map forget <app>` never deletes a
whole app when the identifier matches more than one: it lists the candidates
and deletes nothing, with or without `--yes`. The dry run's confirm command
repeats the identifier you typed.

**Registration edits only its own entry.** `install` and `uninstall` change the
`browser-link` entry of the client's config and keep the rest of the file byte
for byte, line ends included. The write is atomic and makes no backup copy. A
config that is a symlink, lies outside your home directory (unless
`COPILOT_HOME` points there), is not valid UTF-8, does not parse, has the wrong
shape or repeats the key is refused and left unchanged, with a message saying
what was found. Without `--client`, both report every client. A client
that is refused shows `Refused, nothing written: <reason>` and does not stop
the others; the exit code is 1 when any client was refused. A replaced file
keeps its permission bits.

`doctor` starts its slow checks together (both port probes, the running
server's `/version`, the Chrome debugger-flag scan and the live-process
scan), so a run lasts about as long as the slowest process scan instead of
their sum.

#### Windows: skip the npm shim for faster CLI calls

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

## Upgrading to 1.0

1.0.0 is the hardening release. Most of it is stricter checks on who may talk to
the bridge, so a few things that worked before are now refused. If you come from
0.52 or older, do this once:

1. **Update the server:** `npm install -g @jobshimo/browser-link@latest`, then
   restart your MCP client.
2. **Reload the extension** in `chrome://extensions`, from the extension folder
   of the version you just installed (the console's setup step prints its path),
   so the extension and the server are the same version. A 0.51 or older
   extension, or any extension without the pinned id, is refused, and its popup
   says so ("it does not accept this extension's id. Reload the extension from
   the installed browser-link version."). If the id changes, Chrome treats it as
   a new extension and its stored settings (idle timeout, flow recording,
   language) start fresh.
3. **Run the browser as the same OS user as the server.** A browser that runs as
   another user of the machine is refused (see below).
4. **If you used the Admin window to change tools, cdp-direct or MCP client
   registration, use the console instead** (commands below).

Stored activity rows are not changed by the update.

### What now stops a connection

Since 1.0.0 the bridge accepts a connection only if every check passes. The
extension popup shows the reason when one fails, and the [server log](#what-now-stops-a-connection) names the
cause of every refusal:

| Check  | Refused when                                                                                                          | Popup says (short)                               |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Origin | The `Origin` is missing, or is not exactly `chrome-extension://celegobaahdoaigibmjmekhopegfkhpe` or an id you allowed | it does not accept this extension's id           |
| Owner  | The browser process runs as another OS user than the server, or its owner cannot be read                              | runs as another user / could not read which user |
| Name   | The process is not a Chrome, Chromium, Edge, Brave or Vivaldi binary                                                  | not a supported Chromium-based browser           |
| Path   | Strict mode only (below): the executable path is not in your list, or cannot be read                                  | the path is not in `peerExecutablePaths`         |

Three more reasons can appear: the program that opened the connection could not
be seen, it could not be identified, or checking it failed. A connection with no
`Origin` (a script, for example) is refused before any process
lookup runs.

**The server log.** browser-link writes no log file. "The server log" means
the stderr of the server process your MCP client starts. In VS Code (GitHub
Copilot) open it with the Command Palette, **MCP: List Servers**, select
`browser-link`, **Show Output** (see the
[VS Code documentation](https://code.visualstudio.com/docs/agents/run/manage-mcp-servers#_view-server-output)).
The documentation of Claude Code and OpenCode does not say where they show a
local server's stderr, so for them capture it by running the server by hand:
run `browser-link stop` to end the running servers, then start
`browser-link 2> server.log | cat` in a POSIX shell such as Git Bash (piping the output makes it
start as the MCP server instead of the terminal UI) and read `server.log`.

On Windows the server reads the owner of the connection straight from the
kernel's TCP table, which already lists a connection that was just opened
(`netstat` can leave one out for a while). When that cannot run, for example
because PowerShell is locked down, the server logs one line naming the step
that failed and checks with `netstat` instead, which looks again, up to six
snapshots over about 1.25 s, before refusing. If a refusal still happens, the
popup says "The browser-link server refused the connection: it could not
identify the program that opened the connection." (or, when the diagnosis
itself cannot answer, "WebSocket connection failed. Is the MCP server
running?"), and the [server log](#what-now-stops-a-connection) line names the
cause.

**Allowing another extension id (experts only).** To connect your own build of
the extension, add its id to `allowedExtensionIds` in `config.json`, in the data
folder (see [Where your data lives](#where-your-data-lives)):

```json
{ "allowedExtensionIds": ["abcdefghijklmnopabcdefghijklmnop"] }
```

An id is exactly 32 characters, each a letter from `a` to `p`. Any other entry
(a prefix, a wildcard, a full `chrome-extension://` origin) is dropped with a
warning in the [server log](#what-now-stops-a-connection). The pinned id is always allowed. You edit this key by
hand: it cannot be set from the Admin window, the console, the bridge or an MCP
tool. `browser-link doctor` lists the ids in effect.

**Strict mode by executable path (experts only).** `peerExecutablePaths` in
`config.json` makes the server also require the browser's full path to be in a
list you wrote (see [Security model](#security-model)). Before turning it on:

- A list with no valid absolute path refuses **every** browser. A mistyped list
  never turns the check off.
- A `config.json` the server cannot read (it does not parse, or it is not one
  JSON object) never falls back to the defaults: browser-link refuses to work
  until it is fixed. No new browser connection is accepted, every tool call
  answers with the file, the error and the two ways out, and no command or
  screen writes over the file. Fix it by hand, or run
  `browser-link config restore-defaults --yes`: it keeps a copy next to it
  (`config.json.unreadable-<date and time>`), writes the default settings and
  lists every setting you have to re-enter from that copy. A missing
  `config.json` is the defaults, as before.

**Known gap.** The peer check does not tell apart two programs that both run as
your user. A process that runs as you but is confined away from your files, while
it can still open a loopback connection (a Flatpak or Snap app with network
access, a macOS App Sandbox app with `network.client`, a Windows low-integrity
process), passes the same-user check, and it passes the name check if its binary
carries a browser's name. Strict mode closes that gap by path. Malware already
inside your browser is outside this model too (see
[Security model](#security-model)).

On Windows the kernel-table check counts only a row whose two ends are the
peer's endpoint and the server's. Only the `netstat` fallback also counts a
socket that `netstat` lists only as bound (foreign port 0) when no row to the
server exists; if one process has a row to the server and another has a
bound-only row for the same endpoint, the row to the server decides instead of
the lookup refusing as ambiguous.

### The Admin window no longer changes what an agent may do

Anything that can reach the bridge could have made these changes from the Admin
window, so in 1.0.0 the window shows each one as a **readout** (the current value
and the console command) and the server refuses the write. The console does all
of them:

| What                          | Command                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Disable or enable an MCP tool | `browser-link tools disable <tool>` / `browser-link tools enable <tool>`                                       |
| cdp-direct on or off          | `browser-link config set cdp-direct.enabled true` / `browser-link config set cdp-direct.enabled false`         |
| cdp-direct grant lifetime     | `browser-link config set cdp-direct.grant-ttl <minutes>` (a whole number of minutes, or `never`)               |
| Register with an MCP client   | `browser-link install --client <claude\|opencode\|copilot>`; to remove: `browser-link uninstall --client <id>` |

Still available from the Admin window: console language, multi-agent,
auto-reelect, the instructions auto-refresh, the activity trail switches,
`doctor`, the update check, and installing or removing the instructions block per
client. The two hide settings (password values for agents, sensitive values in
the trail) are changed from the console only, with
`browser-link config set hide-password-values <on|off>` and
`browser-link config set activity.hide-sensitive <on|off>`; the window shows
their current state. The cdp-direct port and the downloads folder were already readouts.

### The activity trail

- **Password fields are hidden in the trail.** When `browser.type` or
  `browser.press` acts on a field the page declares sensitive (an
  `<input type="password">`, or an `autocomplete` attribute containing
  `current-password`, `new-password`, `one-time-code`, `cc-number` or `cc-csc`)
  and `activity.hide-sensitive` is on, the row stores `[sensitive field]` in
  `payload` instead of the text or key, whether `activity.record-payloads` is
  on or off, and the typed text is removed from the other columns too (next
  bullet). The tool result carries `sensitive_field: true` or `false`. A call
  that fails on such a field stores the marker too.
- **Where the value is hidden.** With `activity.hide-sensitive` on, a hidden
  row changes these columns, and no other column holds free text:
  `payload` holds the marker; `url` loses its query string and fragment (a form
  sent by GET puts its fields there); `url`, `title`, `selector` and `error` have
  the text a `type` typed replaced by the marker wherever it appears, ignoring
  letter case and also URL-encoded (as a component, or as a browser writes it
  in a path), form-encoded (`+` for a space), JSON-escaped, or in the other
  Unicode normalization form. A typed text shorter than 4 characters is not
  searched for, because it occurs by coincidence in almost any text: `title` and
  `error` become the marker whole, `url` keeps its origin and path, and
  `selector` is kept. A `press` hides its key in `payload` only: one character
  would match almost any text.
- **A field that was not identified.** A `type` or `press` that never said
  which field it acted on is hidden the same way, with `[field not identified]`
  in place of `[sensitive field]`: it failed with a plain error (a stale
  `ref`, a selector that matched nothing, a dropped tab, a bridge timeout or a
  socket that closed), or the connected extension answered without
  `sensitive_field` (it was not reloaded after the update). The marker does not
  claim the field was sensitive. To tell whether the extension reports the
  field, check that the tool result of a `type` or `press` carries
  `sensitive_field`; if it is missing, reload the extension in
  `chrome://extensions` (and reconnect your tabs).
- **Storing everything.** `browser-link config set activity.hide-sensitive off`
  stores such rows like any other row: no marker, nothing replaced, the query
  string stays in `url`, and `activity.record-payloads` alone decides whether
  `payload` holds the text. With `hide-sensitive` on and `record-payloads` off,
  an ordinary row keeps an empty `payload`, a sensitive row still stores
  `[sensitive field]`, and a row whose field was not identified stores no
  payload; the other columns are cleaned in both. The setting is read when the server starts recording the trail, so it
  applies after a restart (restart your MCP client).
- **Rows already stored are untouched.** Text typed before 1.0.0, or while
  `activity.hide-sensitive` was off, stays in `activity.db`; changing the
  setting never rewrites a stored row. To remove it, purge the trail (see
  [Purging](#purging)):
  `browser-link activity clear --from 2000-01-01 --yes` deletes every row and
  then reclaims the disk space. Plain `browser-link activity clear --yes` also
  deletes every row and compacts the file.
- **What is not detected.** Only a field the page itself marks is detected, and
  each row hides only the text of its own call. These are stored as typed:
  - fields the page does not declare sensitive: plain text fields, even one
    named or labelled "password"; fields inside cross-origin iframes, closed
    shadow roots and `contenteditable` elements (reported as not sensitive);
  - `browser.press` on a field that is not marked sensitive (each key is
    stored), and, on a sensitive one, every column but `payload` and the query
    string of `url`;
  - text a later row echoes from an earlier `type`: a `find` text, a
    `navigate` URL, a `browser.evaluate` expression, a page title;
  - `browser.flow` rows, which are never marked sensitive (a flow row stores
    its step kinds, not the text its steps typed; its `url` and `title` are
    stored as they are);
  - URLs with query strings (`navigate`, `download`) and `find` text;
  - a field whose focus changes between the check and the typing;
  - every sensitive row, when `activity.hide-sensitive` is off.
- **Who can read payloads.** Other agents read them through `browser.activity`,
  and bridge clients can read them too. `activity.record-payloads false` is how
  you keep text out of the trail.
- **File mode.** On Linux and macOS the activity database is created readable by
  its owner only (mode 0600), and an existing one is tightened. On Windows that
  mode does little: access follows the permissions of the data folder.

### The pinned extension id

The extension's manifest carries a fixed public `key`, which gives every install
the id `celegobaahdoaigibmjmekhopegfkhpe`. A public key gives a **stable id, not
proof of identity**: an unpacked extension loaded by hand with the same key gets
the same id. The Origin check keeps out pages, scripts and other extensions; the
process checks keep out other users. Neither authenticates the extension itself.

### Chrome version

The minimum is Chrome 118 (the manifest declares it). CI runs the end-to-end
suite on Linux against two Chromes: Chrome for Testing 118.0.5993.70, which
blocks the npm publish, and the runner's stable Chrome, which reports without
blocking (a failure on `main` opens an issue). Each run records the browser it
used (`browser`, `product`, `revision`) in the job's step summary and in the
`e2e-result-chrome-118` / `e2e-result-chrome-stable` artifacts
(`packages/e2e/build/e2e-result.json` locally, or `E2E_RESULT_FILE`). It covers the
pinned Origin being accepted while the server enforces it, the 1.1.0 click,
focus, settle and cut rules (a click whose target first has to be scrolled into
view included), and download attribution (a click's download captured, another
tab's left alone), including the cases where Chrome's copy must be kept.

A differential job (`e2e-diff`, Chrome 118) guards refactors: the current
harness drives the build of the PR's merge-base and the PR's build, records
every tool call (`E2E_RECORD=<file>`), normalises both records with the
committed table in `packages/e2e/src/normalise.mjs` (ids, timings, paths,
ports, image payloads) and requires them to be equal; a difference prints the
first differing call with both values. It runs on PRs that touch the extension
source, `packages/core`, the server's CDP or protocol code, or the extension
build, and adds a self-diff (two runs of the same build) when the harness, the
table or the fixtures change. Locally: `pnpm build`, then
`node scripts/e2e-diff.mjs origin/main` (or `--self-diff-only`). A PR meant to
change behavior carries the `behavior-change` label instead (see
[End-to-end cases and the differential gate](#end-to-end-cases-and-the-differential-gate)).

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│  Your MCP client (Claude Code, OpenCode, Copilot CLI, …)         │
└──────────────────────┬───────────────────────────────────────────┘
                       │  stdio (MCP)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  browser-link MCP server (Node ≥ 22.22.2)                        │
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

The MCP server registers two families of tools — 34 bridge tools that
drive the connected tab, read the activity trail or the manual, or close the
knowledge loop, and 6 persistent-map tools (2 read, 4 write): 40 in all. All
40 are individually toggle-able (`browser.activity` since 0.44.0;
`browser.wrap_up`, `browser.read` and `browser.feedback` since 0.45.0) — see
[Per-tool permissions](#per-tool-permissions).

**Browser bridge — read-only** (no claim required, observation only):

| Tool                        | Purpose                                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser.list_tabs`         | List tabs currently connected through the extension, with claim status (`claimed_by` / `claimed_by_me`), the extension's `extension_version`, `extension_outdated: true` when it is older than the server or `extension_newer: true` when newer, with a `version_note` |
| `browser.my_tabs`           | List the tabs the calling agent currently holds a claim on                                                                                                                                                                                                             |
| `browser.ping`              | Verify the bridge to a tab; returns its title and URL                                                                                                                                                                                                                  |
| `browser.snapshot`          | Title, URL, visible text and interactive elements with selectors; filterable, pierces open Shadow DOM + iframes; `since` returns only what changed; a cut result carries `truncated`, `offset` returns the rest                                                        |
| `browser.find`              | Locate one element by visible text, by `ref` or by `semantic_key` (`key`) → selector + coordinates; `near_misses` on no match, `candidates` on ambiguity; carries `ref`; `truncated` and `offset` when candidates were cut                                             |
| `browser.state`             | Compact orientation read — URL/title/viewport/focused element/open dialogs/scroll — cheaper than a full snapshot                                                                                                                                                       |
| `browser.canvas_screenshot` | Screenshot a `<canvas>` as PNG/JPEG, for DOMless UIs (Qt-WASM, WebGL) where snapshot/find return nothing                                                                                                                                                               |
| `browser.screenshot`        | Screenshot the viewport, the **full page** or one element as PNG/JPEG, returned as an image (long pages are scaled to `max_dimension`; results capped at ~8 MB; an element larger than its iframe/scroll container is only painted as far as that container shows it)  |
| `browser.console`           | Rolling buffer of recent console messages (last 200)                                                                                                                                                                                                                   |
| `browser.network`           | Rolling buffer of recent network requests (last 200)                                                                                                                                                                                                                   |
| `browser.network_body`      | Fetch the response body of one request by `request_id`                                                                                                                                                                                                                 |
| `browser.wait_for`          | Wait for a selector / `ref` / JS expression / network request URL to match a condition                                                                                                                                                                                 |
| `browser.wait_for_tab`      | Wait for a popup/`window.open` tab spawned by a connected tab; auto-claims it for the caller                                                                                                                                                                           |
| `browser.flow_status`       | Progress, outcome and action manifest of one `browser.flow` run by its `flow_id` — the handle on a detached flow                                                                                                                                                       |
| `browser.events`            | Bridge lifecycle log (tab registered/disconnected/renamed/claimed/released, primary elected, detached flow finished); paged with `since_id`                                                                                                                            |
| `browser.activity`          | On-disk [activity trail](#activity-trail) — every action every agent dispatched, filterable by agent, tab, tool, flow or outcome; survives restarts                                                                                                                    |

**Browser bridge — actions** (most auto-claim the tab on first use — the
two exceptions are footnoted):

| Tool                     | Purpose                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser.navigate`       | Send a tab to a different URL (waits for load by default)                                                                                                |
| `browser.click`          | Click an element by CSS selector or `ref`; hit-tests first and fails on occlusion, `retargeted` or no visible box (`force:true` to bypass)               |
| `browser.type`           | Focus an input (by selector or `ref`) and type text via the native value setter                                                                          |
| `browser.press`          | Trusted CDP key press (+ modifiers), optionally focusing a selector or `ref` first — real `isTrusted:true` input, for widgets synthetic events miss      |
| `browser.drag`           | Drag element→element or coordinate→coordinate; HTML5 or pointer-based, auto-detected                                                                     |
| `browser.flow`           | Run a declarative find/click/type/press/wait_for/drag/sleep/repeat sequence in one round trip; fail-fast, max 20 steps, `dry_run` and `detach` available |
| `browser.flow_cancel`    | Stop a running flow by `flow_id`; lands within one step and keeps the partial results [^cancel-claim]                                                    |
| `browser.evaluate`       | Run an arbitrary JavaScript expression in the page and return its result; `as` names it in the JS registry                                               |
| `browser.dialog_respond` | Answer a pending native `alert` / `confirm` / `prompt` / `beforeunload` [^dialog-claim]                                                                  |
| `browser.set_permission` | Pre-grant or pre-deny a browser permission (geo, notifications, camera, …) for an origin                                                                 |
| `browser.download`       | Download a file — click a button or fetch a URL — with no native "Save as" dialog; see [Downloads](#downloads)                                           |
| `browser.claim_tab`      | Reserve a tab cooperatively for the calling agent (multi-agent mode)                                                                                     |
| `browser.release_tab`    | Release a tab claim the calling agent holds                                                                                                              |
| `browser.reset`          | Soft-reset the bridge — drop tabs, claims and events; keep the server alive [^reset-global]                                                              |
| `browser.read`           | Run a kept JS reader of the tab's app by name, with its `<PLACEHOLDER>` values; counts the outcome                                                       |
| `browser.wrap_up`        | Before answering: list what the session left pending, then keep/drop it in one transaction                                                               |
| `browser.feedback`       | Leave the owner a local note about a tool that misbehaved; never opens an issue                                                                          |

[^dialog-claim]:
    `dialog_respond` deliberately bypasses the claim guard — a dialog
    freezes the tab's JS thread, and unblocking it should not require
    holding the claim. First responder wins.

[^cancel-claim]:
    `flow_cancel` bypasses the claim guard for the same reason, and it
    matters more here: it is a kill switch. Requiring ownership to STOP a
    runaway loop would mean the one agent that can see the problem is the
    one agent that cannot fix it.

[^reset-global]:
    `reset` is global — it takes no `tab_id` and touches no claim; it
    drops every tab, claim and event on the bridge at once.

`click` / `type` / `press` share a `settle_ms` option (see below). `find`,
`click`, `type`, `press`, `drag` (endpoint resolution only) and
`snapshot`/`state` all pierce open Shadow DOM roots and same-origin
iframes, nested arbitrarily.

### Behavior worth knowing before you rely on it

- `browser.network` takes `headers: false` to leave out request and response
  headers from every entry (usually most of the payload) when status, URL and
  timing are enough. The default (`true`) is unchanged.
- A `ref` whose node was replaced is re-found by its semantic key inside
  same-origin iframes as well, the same places `browser.find({ key })`
  searches.

| Behavior                           | What to know                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shadow DOM / iframe piercing**   | `snapshot`, `find`, `state`, `click`, `type`, `press` and `drag`'s selector endpoints reach into OPEN shadow roots and same-origin iframes, nested arbitrarily. They CANNOT reach CLOSED shadow roots (`attachShadow({mode:"closed"})`) or cross-origin iframes — there is no CDP-level workaround for either. A selector that matches structurally-identical twins across roots comes back with `ambiguous: true`; use it immediately and never cache it in the map.                                                                                                                                                                                                                                                                                                                                            |
| **Occlusion guard**                | `browser.click` hit-tests the target's own click point before dispatching. If a different element covers that point, the call returns `ok:false` describing the blocker instead of clicking the wrong thing blindly. Pass `force:true` to bypass the guard intentionally: a covered target is then clicked at its position. A target with no visible box fails before the hit-test, see [A target with no visible box](#a-target-with-no-visible-box-and-a-target-that-takes-no-focus).                                                                                                                                                                                                                                                                                                                          |
| **`near_misses`**                  | When `browser.find` matches nothing, the response can carry up to 3 ranked candidates as hints for a follow-up `find` call — they are suggestions for re-finding, never selectors to click on directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **`browser.flow` recipes**         | The persistent map can store named, replayable flow recipes validated against the exact `browser.flow` step grammar, and the placeholder privacy rule that protects them — see [Persistent UI map](#persistent-ui-map).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **A cancelled flow is `ok:true`**  | Stopping a flow from the popup returns `{ ok: true, stopped_by: "cancelled", steps_completed: N, results: [...] }` — a success, not an error. The steps that already ran really ran, and reporting them as a failure (or dropping them) would be a lie about irreversible work. See [Stopping a running flow](#stopping-a-running-flow--the-kill-switch).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Detached flows keep acting**     | `browser.flow({ detach: true })` returns at once and keeps clicking **between agent turns** — with no agent attached, and for up to 30 minutes. The popup's Stop button is the kill switch, and the only actor guaranteed to be present. One detached flow per tab. See [Detached execution](#detached-execution--flow_status--flow_cancel).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **`extension_outdated`**           | Each extension tab in `browser.list_tabs` carries `extension_version` (what the extension reported when it connected). When that is a plain `MAJOR.MINOR.PATCH` lower than the server's version, the tab also carries `extension_outdated: true`: results from that tab may lack fields newer servers add, so update or reload the extension. When it is higher, the tab carries `extension_newer: true` instead: the server runs older code, so restart it (`browser-link stop`, then restart the agent). Either flag comes with `version_note`, a plain sentence naming what does not work until then. An extension older than 0.39.0 sends no version, so its tabs carry none of these fields; cdp-direct tabs never do. The extension popup shows the same skew, in either direction, in its version banner. |
| **No auto-resume after a restart** | Chrome can terminate the extension's MV3 service worker mid-flow. browser-link marks such a flow `failed` / `worker-terminated` on the next worker start and NEVER resumes it — a resume could double-act on irreversible work whose real progress died with the worker. Its manifest is gone; re-derive from the page before relaunching. See [No auto-resume](#no-auto-resume-after-a-worker-restart).                                                                                                                                                                                                                                                                                                                                                                                                         |

#### `retargeted` — a click that would land on an ancestor

When the element at the click point is an **ancestor** of the target (a wrapper
that would receive the click instead) and it does not have
`pointer-events: none`, `browser.click` fails with `reason: "retargeted"` and
an error naming both elements, instead of reporting `clicked` on the wrong
node. Scroll or expand the container, or target the element that receives
clicks; `force: true` clicks at that point anyway. `hit_element` now appears
only on a successful click that passed through a `pointer-events: none`
element, or on a `force` click.

#### A target with no visible box, and a target that takes no focus

`browser.click` never clicks by pointer at a target with no visible box, and
never at the page origin (0,0). The page decides, for the target itself, that
it has no visible box when the browser says it is not rendered or has
`visibility: hidden` (`checkVisibility` with the visibility property: a
`display: none` on the target or an ancestor, a closed `<details>`,
`content-visibility`; where `checkVisibility` is missing, a computed
`visibility` of `hidden` or `collapse`), or when it has no client rectangle at
all (`display: none`, `display: contents`, an `<option>` of a `<select>`). A
rectangle of size zero still counts as a box, and so does `opacity: 0`; only an
empty rectangle whose click point is exactly the top-left corner of the
viewport is treated as no box (the same for an endpoint of `drag`).

- Without `force` the call fails: `Element <target> has no visible box (not rendered, visibility-hidden, or an option of a select), so there is no point to click: make it visible first (open its menu, dialog or section), or pass force: true to call the element's own click() with no pointer`.
- With `force: true` a covered target is clicked at its position, as before. A
  target with no box gets its own `click()` and no pointer, and the result
  carries `programmatic_click: "the target has no visible box, so its own click() was called: no pointer, no mouse events, no coordinates"`.
  What the agent loses with it: no hit-test, no hover, pointer, `mousedown` or
  `mouseup` events, no coordinates, and the click event is not trusted
  (`isTrusted: false`); focus moves only if the element takes it itself. The
  forced click is refused, with nothing clicked, when its `click()` could do
  nothing: on a disabled target (`:disabled`, which includes a disabling
  ancestor `<fieldset>`) it fails with `Element <target> is disabled, so its own click() does nothing and nothing was clicked: wait until it is enabled, or find the control that enables it`,
  and on an `<option>` or `<optgroup>` with `Element <target> is an <option> (or <optgroup>): clicking an option does nothing and it never selects it, so nothing was clicked; the select's value must be set instead`.
- `browser.drag` fails the same way for a selector endpoint with no visible
  box: `drag: from_selector <selector> has no visible box (not rendered or visibility-hidden), so there is no point to drag from: make it visible first` (`to_selector` for the other endpoint).
  Nothing is sent, and `drag` has no `force`.
- `browser.type`, and `browser.press` with a `selector` or `ref`, focus the
  target and check that focus is where they asked: the target, an element
  inside it (a shadow root that delegates focus), the control of a `<label>`,
  or the editable area that contains it. Otherwise nothing is sent and the
  call fails with `Element <target> did not take focus (<why>), so nothing was typed: the input would have gone to whatever had focus before; target the field itself`
  (`pressed` instead of `typed` for `press`). `<why>` is `it has no visible box`,
  `it is disabled` or `it is not focusable`.

#### `truncated` and `offset` — a cut result says so

`snapshot` and `find` return a window of what they scan: up to
`max_interactive` interactive entries (default 120, at most 500), 30 headings
and 4000 characters of text; a `find` that matches several elements lists 5
candidates. When something after the window was left out, the result carries:

```
truncated: { interactive?, headings?, text?, not_compared?,
             not_compared_headings?, not_compared_text?, next_offset?, hint }
```

- `interactive`, `headings` and `text` count what was left out (entries;
  characters for `text`), counted from the full scan.
- `next_offset` holds, for every non-empty part of the result, where the next
  window starts. Pass it back as `offset` to get the rest, with nothing
  twice. `hint` says how to narrow the scope (`within_selector`, `exclude`,
  `only_interactive`) or to continue.
- A `multiple-matches` answer of `find` carries
  `truncated: { candidates, next_offset: { candidates }, hint }`; `offset: { candidates }`
  applies to a search by `text` only. A failing `find` step of a `browser.flow`
  says how many candidates were left out and repeats `truncated` in its error.
- A result where nothing was cut has no `truncated`: it holds everything in
  scope, with the fields it always had.
- The text window never ends between the two halves of a surrogate pair, so
  the pages of `text` concatenate to the text.
- When an `offset` was given and every requested part came back empty, the
  result carries `offset_past_end`: `{ <part>: { offset, total } }` for each
  part asked at or past its end (`find`: `{ candidates: { offset, total } }`).
  Nothing is left there, which is not the same as the page having nothing.
  Paging with `next_offset` never carries it.
- `offset` is `{ interactive?, headings?, text? }` for `snapshot` and
  `{ candidates? }` for `find`, each a non-negative integer. Anything else is
  refused, never dropped: `browser.snapshot: offset must be an object like truncated.next_offset`,
  `browser.snapshot: offset.<part> is not one of interactive, headings, text`,
  `browser.snapshot: offset.<part> must be a non-negative integer` (`browser.find` likewise,
  and `browser.find: offset applies to text mode only` with `ref` or `key`).

A result built while part of the page was not walked carries `not_walked`: a
string saying that shadow roots or frames nest deeper than 20 levels and
were skipped, so a miss may be a cut. `snapshot`, `find` and `state` carry it
as a field; a `click` or `type` whose target is not found, and a failing
`find` step of a flow, carry it in parentheses at the end of the error. It is
absent when nothing was skipped.

#### `snapshot({ since })` — diff instead of re-sending the page

Take one full `snapshot` per view, keep its `snapshot_id`, and pass it as
`since` for every later look at the same view. The result is a diff:

```
{ title, url, doc_id, snapshot_id, since, added, removed, changed, overflow? }
```

- `added` and `changed` are full entries (added first); `removed` is
  `{ ref, tag, text? }`.
- `max_interactive` applies after diffing, to `added` + `changed`;
  `overflow` (how many were dropped) appears only when above 0, and a cut
  diff carries `truncated` like a full snapshot.
- A diff compares at most the first 500 interactive entries of each snapshot,
  the first 30 headings and the first 4000 characters of text. What it did not
  compare is counted in `truncated`: `not_compared` (entries of this snapshot
  and of the recorded one past the first 500), `not_compared_headings` and
  `not_compared_text` (headings past the first 30 and characters past the
  first 4000, of both snapshots; not with `only_interactive`). A change beyond
  those limits is not in the diff: take a snapshot without `since` and page
  through it with `offset`, or narrow with `within_selector`.
- `headings` / `text` appear in a diff only when `only_interactive` is
  false **and** they changed.
- An invalid `since` (not a string, or over 64 characters) is dropped and a
  plain full snapshot is returned. A `within_selector` miss ignores `since`.

When no diff can be made, the result is the **full** snapshot plus `since`
and `since_status`, so the call is never wasted. Keep the new
`snapshot_id` it carries:

| `since_status`         | Meaning                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `doc-changed`          | the `since` prefix is not the current `doc_id` (new document), or it has no `:`   |
| `evicted`              | same document, but `since` is not among the last 4 snapshots, or was never issued |
| `observer-unavailable` | the page observer is not running in the tab                                       |

**Fields.** When the page observer runs in the tab, interactive entries in
`snapshot`, `find` (single match, `candidates`, `near_misses`) and
`state.focused` carry `ref` (`<doc_tag>:e<N>`, for example `k3x9ab:e12`),
a per-document element handle that is reused while the node lives. The
`doc_tag` is the first 6 characters of `doc_id`. A `ref` is valid only for
the document that issued it and dies with the document. Results also carry `doc_id`, and
`snapshot` results carry `snapshot_id` (`<doc_id>:s<N>`). All of these are
additive and absent when the observer is not in the page. A `ref` is also an
action target: see [`ref` as a target](#ref-as-a-target--stable-identity-for-this-document).

**Password values.** `snapshot` and `find` return the `value` of filled
inputs, password fields included, so the agent can type and check them.
`browser-link config set hide-password-values on` hides them; the Admin window
shows the setting but does not change it. The setting is read on every call, so it applies to the
next one, with no restart. For a password field (an `<input type="password">`,
an `autocomplete` containing `current-password`, `new-password`,
`one-time-code`, `cc-number` or `cc-csc`, or a field an earlier call with the
setting on saw as a password and that has since become a text input) the entry
then carries `value_hidden: "filled, N characters"` (`"filled, 1 character"`
for one) instead of `value`, and no `text`. `find` neither matches on the value
nor quotes it, in a candidate, a near miss or an error; it still matches the
field's `aria-label`, placeholder or title. Every `snapshot`, `find` and
`browser.flow` result then carries `values_hidden`, a note saying that a user
setting hid the value, so a field showing `value_hidden` is not read as broken.
The `find` steps of a flow and its recovery snapshot hide the values too. An
answer without `values_hidden` (an extension older than the server ignores the
option) is withheld: the call fails with `the user's setting hide-password-values
is on, but the browser answered without hiding password values`, and a flow that
fails this way has already run.

**Selectors can change.** The structural selector adds `:nth-of-type` only
when siblings force it, so inserting a sibling can change a neighbour's
selector and list that neighbour in `changed`. The selector did change: use
the current one.

The result shapes are the same on the extension and on cdp-direct tabs, so
the [cdp-direct support table](#cdp-direct-mode-no-extension) needs no
change.

#### `ref` as a target — stable identity for this document

`click`, `type`, `press`, `find`, `wait_for` and the matching `browser.flow`
steps accept `ref` (`<doc_tag>:e<N>`, taken from the latest `snapshot`, `find` or
`state` of the **current** document) in place of a CSS selector. Prefer it
over a selector you copied earlier: a selector can change when siblings are
inserted (see above), a live `ref` still names the same node.

| Tool            | Target rule                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click`, `type` | exactly one of `selector` or `ref`                                                                                                                              |
| `press`         | at most one of `selector` or `ref` (neither: the key goes to whatever has focus)                                                                                |
| `wait_for`      | exactly one of `selector`, `ref`, `expression` or `network_url`; `ref` takes the same `condition` as selector                                                   |
| `find`          | exactly one of `text`, `ref` or `key`; `role` and `exact` apply to `text` only, any other combination is rejected                                               |
| `flow` steps    | a step `ref` beats the implicit target of a preceding `find`; `selector` and `ref` together are rejected; a `find` step takes `text` (and `role`, `exact`) only |

**Resolution.** A `ref` whose node is still in the page resolves directly, and
so does the same node after it was detached and re-attached (it is not
marked `reresolved`). If the node is gone (a list re-rendered and replaced it), the
observer looks it up again by the element's **semantic key**, recorded when
the `ref` was issued: the same role, the same accessible name and an identical
ancestor tag path, and exactly one element must match. Sibling indices are
kept in the key but never choose between candidates. That one element must
also have first appeared after the original node was gone (a re-render; the
removal of the original and the insertion of its replacement in the same
mutation record count). When that rebind succeeds the result carries
`reresolved: true` and the action proceeds on the new node. A look-alike that
already existed while the original was alive (the other of two identical rows,
when one of them is deleted) is never taken: the `ref` fails with `ref-stale`,
and so it does when the observer did not see the original removed. The observer
records insertions and removals from the moment it issues the first `ref` of a
document, so an element connected before then counts as already existing. A
changed name or role invalidates the `ref`.

**Failures.**

| Error                                                                                       | Meaning and next step                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ref-stale: <ref> not found in document <doc_id>: the element is gone, take a new snapshot` | The node is gone and no rebind is allowed (no match, several, or a look-alike that already existed), or the `ref` belongs to another document. Take a fresh `snapshot` (or `find`) and use the new `ref`.                                                                                                                                                                                                                                                                                 |
| `observer-unavailable: …`                                                                   | The page observer is not running in the tab, so a `ref` cannot be resolved. Use a selector.                                                                                                                                                                                                                                                                                                                                                                                               |
| `wait_for` on a `ref` that no longer resolves                                               | For `hidden` and `detached` the element counts as missing (`attached` false, `detached` true) and the wait is met. For `visible` and `attached`, a `ref` of another document fails at once with the `ref-stale` message; a `ref` whose node is only gone keeps polling and ends `matched: false, reason: 'timeout'` plus `ref_gone: "<ref> not found in document <doc_id>: the element is gone, take a new snapshot"`, and a flow `wait_for` step's failure text ends with that sentence. |

**Properties.**

- Re-resolution never crosses documents. A `ref` carries its document tag,
  so after a navigation or reload (a new `doc_id`) every earlier `ref` fails
  with `ref-stale`, even when the new document has issued the same number. A
  bare `e<N>` without a tag (the 0.36.0 format) is rejected by the server as a malformed `ref` before it reaches the page.
- Identical rows (same role, accessible name and tag path) are refused with
  `ref-stale`, never guessed, so a `ref` never silently moves to a different
  row. `find({ key })` with `path` applies the same rule.
- Re-resolution searches the document and its shadow roots, not iframes;
  `find({ key })` also searches same-origin iframes.
- `browser.map.save` refuses a `semantic_key` on an `ambiguous` entry only
  when the payload carries `ambiguous: true`: copy that flag from the
  `snapshot` or `find` result into the payload.
- The selector path is unchanged: a call with `selector` behaves as it did
  before `ref` existed, and tests pin that.

**`semantic_key`.** A single-match `find` (by text, by `ref` or by `key`)
also returns `semantic_key: { role, name, path: [{ tag, index }] }`. Pass it
back as `find({ key })` to locate the element again by role and accessible
name: a unique match returns the usual single-match result, otherwise the
call reports a counted `not-found` (for example, how many candidates share
role and name, or role, name and tag path). `candidates`, `near_misses` and `snapshot` entries do not
carry the key.

#### `settle_ms` — settle proves QUIET, not EFFECT

`click` / `type` / `press` accept a `settle_ms` option (default 150 ms,
`0` disables it): after dispatching the action they wait until the page
goes quiet — no DOM mutations for that many consecutive milliseconds —
and fold the "wait, then re-check" round trip into the action call
itself. The result carries a compact report:

```
{ settled, duration_ms, mutation_count, url_changed?, focus_moved?, reason?, changes, observer?, unobserved? }
```

`changes` is what the action caused, measured from a mark taken right
**before** the action dispatches. A page observer installed when the tab
connects (and again in every new document) records every DOM mutation, so
mutations the action causes synchronously are counted too:

```
changes: { records, targets, kinds: { childList, attributes, characterData },
           roots: { document, shadow, frame }, descriptors: [{ tag, id?, role?, path }],
           overflow, truncated? }
```

| Field                         | Meaning                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `records` / `kinds`           | mutation records since the mark, in total and per kind                                |
| `targets`                     | mutated elements (an element touched in two flushes counts twice)                     |
| `descriptors` / `overflow`    | the most-mutated targets (up to 20) and how many more there were                      |
| `truncated`                   | `true` when the observer had already dropped older summaries                          |
| `mutation_count`              | `changes.records` plus the records seen inside same-origin frames                     |
| `url_changed` / `focus_moved` | compared with the URL and focused element at the mark, not at the end of the dispatch |

- **Fallback.** When the observer could not report for this action,
  `changes` is `null` and `observer` says why (`"observer-unavailable"`,
  `"doc-changed"` when the action replaced the document, or
  `"changes-error"`). The other fields then come from the quiet-window
  watch alone, as before: it starts right after the dispatch, so
  mutations that finish in that gap are invisible there.
- **What it watches.** The page observer records the top document and its
  shadow roots. The quiet-window watch covers the same, and every same-origin
  iframe document, including iframes and shadow roots that appear during the
  wait. In a document whose page observer is current, the shadow roots come
  from it, closed ones included. Records inside frames are added to
  `mutation_count` (they are not in `changes`).
- **`unobserved` — what settle could not watch.** The field is present only
  when part of the page was not watched: `{ cross_origin_frames?,
shadow_roots?, hint }`. `cross_origin_frames` counts the cross-origin iframes
  whose document cannot be read. `shadow_roots: "open-only"` means a document
  had no current page observer (absent, older, or not covering the whole
  document), so settle scanned for open roots only: closed shadow roots, and
  roots attached during the wait to elements already in the page, were not
  watched. A change in an unwatched part is not in `mutation_count` and did not
  delay `settled`, so `settled: true` and `mutation_count: 0` say nothing about it.
- **A limit settle cannot report.** A closed shadow root that the page declared
  in markup (`shadowrootmode="closed"`), or created before the page observer
  was installed, is not known to anything, so `unobserved` does not mention it.
  The observer is installed when the tab connects, so this includes every closed
  root of a tab connected after the page loaded.
- **Quiet is not effect.** Async reactions that start after the quiet
  window are invisible either way — `settled: true` proves the page went
  quiet, not that every effect has happened.
- **`reason: "context-destroyed"`** means the action navigated the page,
  destroying the observer's execution context. The action itself still
  succeeded — this is a strong navigation signal, not an error.
- **Waiting for a specific expected condition** (an element appearing, a
  request completing) is `expect`'s or `browser.wait_for`'s job, not
  settle's. `browser.wait_for` by selector searches open Shadow DOM roots
  and same-origin iframes, like `browser.find` and `browser.click`.
- **Throttling is not settle's job either.** Settle returns as soon as
  the page stops mutating, so on an already-idle page it collapses to
  nothing. For a pause that is always spent in full — pacing repeated
  actions against a rate-limited backend — use a `sleep` step inside
  `browser.flow` (below).

#### `expect` — assert the effect, not just the quiet

`click` / `type` / `press` (and the matching `browser.flow` steps) accept
an optional `expect`, any combination of:

| Key                   | Holds when                                                               |
| --------------------- | ------------------------------------------------------------------------ |
| `url_changed`         | `location.href` differs from its value right before the action           |
| `selector_appears`    | a **visible** element matches the selector (deep Shadow DOM / iframes)   |
| `selector_disappears` | no **visible** element matches the selector any more                     |
| `text_appears`        | the text is visible on the page (case-insensitive, whitespace-collapsed) |
| `timeout_ms`          | expectation window, default 3000, max 10000 (out-of-range is rejected)   |

After dispatch and settle, the page is polled until every condition holds
or the window closes. Met: the result gains `expect: { met: true,
elapsed_ms }`. Unmet: `ok: false` with `expectation not met: <which> after
<ms>ms` plus the settle report; inside a flow it fails that step fail-fast
(with the usual `recovery_snapshot`). Works on `cdp:` tabs too.

```js
browser.click({ tab_id, selector: 'a.next-lesson-link', expect: { url_changed: true } });
```

`expect` asserts a **transition**. The page is sampled right before the
action: `selector_appears` / `text_appears` must be absent beforehand and
present afterwards; `selector_disappears` must be present beforehand and
gone afterwards. A condition that already held before the action fails
immediately (`selector_appears "[role=dialog]" was already present before
the action`), because it cannot prove the action did anything.
`url_changed` compares against the URL sampled right before _this_ action,
so a navigation still pending from a previous step can satisfy it — when
chaining navigations, confirm the earlier one landed first.

An action with `expect` adds its window to a flow step's worst-case
budget, so a long run of expectant steps can trip the 60 s up-front
rejection.

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

#### `repeat` — bulk work without leaving the guaranteed zone

`{ repeat: { steps, max_iterations, while_found?, delay_ms? } }` runs a
sub-sequence up to `max_iterations` times. It exists for the shape the
bridge previously could not express at all: _click every element matching
X, pause, repeat until the list drains._ Before it, the only way to do
that was a loop inside `browser.evaluate` — which is exactly where every
guarantee is lost, since `el.click()` is `isTrusted:false` and there is
no occlusion guard, no recovery snapshot and no record of what happened.
A `repeat` keeps all of it, in **one round trip**.

It is bounded by construction, and that is deliberate:

- **`max_iterations` is required.** It is what keeps the flow's worst
  case statically computable, which is what the up-front 60-second
  rejection rests on. The budget is `max_iterations × (inner steps +
delay_ms + a while_found probe)`, and a repeat that projects over the
  ceiling is rejected before anything runs.
- **Repeats do not nest**, and inner steps count against the same 20-step
  ceiling as outer ones — a ceiling that only counted the outer array
  would let one repeat smuggle in an arbitrarily long body.
- **Each iteration starts with a fresh implicit target**, and none
  escapes in either direction. Put the `find` inside the body.

**How many iterations actually fit.** The budget is
`2000 + max_iterations × (inner steps + delay_ms + a 500 ms while_found
probe) ≤ 60 000`, where a click costs 2 500 ms with default settle or
500 ms with `settle_ms: 0`:

| Body                                                      | Per iteration | Max iterations |
| --------------------------------------------------------- | ------------- | -------------- |
| 1 click, default settle                                   | 2 500 ms      | **23**         |
| 1 click, `settle_ms: 0`                                   | 500 ms        | **116**        |
| 1 click, `settle_ms: 0` + `while_found` + `delay_ms: 250` | 1 250 ms      | **46**         |

Those are measured, not estimated. So `repeat` is **not** primarily a
throughput win over an `evaluate` loop — draining a 956-row list still
takes ~21 calls. It is a _safety_ win: trusted input, occlusion guard, a
per-iteration record, and a flow that is bounded and rejectable before
it starts. To lift the 60-second ceiling — and do the whole thing in one
call — see [Detached execution](#detached-execution--flow_status--flow_cancel).

`while_found` is the early stop: before each iteration the loop checks
whether that selector still matches something **visible**, and stops the
first time it does not (`stopped_by: "condition"`, otherwise
`"max_iterations"`). Prefer it over reading a page counter to decide when
you are done — counters routinely vanish at zero and leave a stale value
that reads as a phantom last item.

#### `dry_run` — check before an irreversible bulk run

`browser.flow({ …, dry_run: true })` validates and **projects** the flow
without dispatching a single input event, navigation or pause. Each
repeat entry reports `max_iterations`, `inner_steps`, `delay_ms`,
`while_found` and `would_start` — whether the condition matches right
now. The response also carries `budget_ms` (the flow's computed worst
case) and `requires_detach`.

Only the exact boolean `true` opts in. Any other value runs the flow for
real, because a dry run that silently became a real run would be the
worst possible failure of this flag.

**A dry run is never rejected for being too long.** It is judged against
the 30-minute detached ceiling, not the 60-second synchronous one, so any
flow you could legally run either way can be projected first. Before
v0.27.0 an oversized flow was rejected _before_ it was projected, which
made the one question `dry_run` exists to answer unanswerable for exactly
the runs where it matters most; `requires_detach: true` now tells you
which mode the real run needs instead.

> It answers _"would this start, and what is my ceiling?"_ — **not** _"how
> many elements match?"_. Reporting a live match count would need a new
> deep-query primitive; that is a deliberate follow-up, not an oversight.

#### Stopping a running flow — the kill switch

Every `browser.flow` call is assigned an opaque `flow_id`, returned on the
result (success, failure and cancellation alike). While a flow runs, the
extension popup lists it under **Flows** with a one-click **Stop** — no
confirmation, no second step. See [the Flows panel](#the-flows-panel) for
what the panel shows.

Three things are worth knowing before you rely on it:

- **A cancelled flow is a success, not an error.** It comes back as
  `{ ok: true, stopped_by: "cancelled", steps_completed: N, results: [...] }`
  with everything it managed to do. Partial work is never discarded —
  after a bulk run that was stopped half-way, "what did it already do?"
  is the only question that matters, and an error payload could not
  answer it. A `repeat` that was stopped reports its own
  `stopped_by: "cancelled"` and the `iterations_completed` it finished;
  if the stop landed part-way through an iteration, that iteration's
  steps are reported separately as `partial_iteration` rather than
  counted as complete.
- **A flow that runs out of time returns its partial state, not an
  error.** The server computes the worst-case budget from the real
  per-action cost — each click / type / press is charged its
  `settle_timeout_ms` (default 2 000 ms, accepted on flow steps), never
  `settle_ms`; a repeat multiplies by `max_iterations` and adds
  `delay_ms` — and gives the runner a deadline 3 s shorter than the
  bridge timeout. At the next step or iteration boundary after it, the
  runner returns `{ ok: true, stopped_by: "timeout", steps_completed: N,
results: [...] }` (a `repeat` adds `iterations_completed` and, for an
  interrupted iteration, `partial_iteration`). Unlike a human stop, a
  timeout is not a decision: the agent may continue the remaining work,
  but must not blindly relaunch steps that already completed if they are
  irreversible — resume from the counts. If the runner is wedged inside
  a single step and cannot answer, the server cancels it and recovers
  what the flow registry knows (`steps_completed`, `iterations_completed`,
  `flow_id`, `results_available: false` — the per-step results are lost
  in that case). In that recovered case `steps_completed` can also be
  **one lower** than what really ran — the step in flight when the
  cancel landed is not counted — so verify the page state of the first
  step to re-run instead of blindly repeating it. A detached flow has its own 30-minute ceiling instead.
- **Worst-case latency is one step.** Cancelling means the runner declines
  to dispatch step N+1 — it does not interrupt a CDP command already in
  flight, because nothing can. The flag is checked before every top-level
  step, before every repeat iteration, and before every step inside a
  repeat body, and `wait_for`'s poll loop checks it on every tick, so
  stopping during a 30-second wait returns within one poll interval
  rather than at the timeout. The honest edge: a `sleep` step and a
  repeat's `delay_ms` pause are each one step, and each runs to
  completion (up to 30 s) before the next check.
- **Stopping something that already stopped is a no-op**, not an error.
  The popup, the agent and the flow's own completion race by nature, and
  every one of those races ends with the flow not running.

#### Detached execution — `flow_status` / `flow_cancel`

`browser.flow({ steps, detach: true })` returns **immediately** with
`{ flow_id, detached: true, started_at, steps, expires_at }` and keeps
running in the background. It is the only thing in browser-link that
keeps acting with no agent attached — read
[Security model](#security-model) before you reach for it.

Everything a foreground flow guarantees still holds: trusted CDP input,
the occlusion guard, per-iteration records, fail-fast with a recovery
snapshot, the popup Stop button. What changes is who waits.

| Aspect       | Foreground flow                           | `detach: true`                                                      |
| ------------ | ----------------------------------------- | ------------------------------------------------------------------- |
| Returns      | The full result                           | An ack with the `flow_id`                                           |
| Time ceiling | 60 s worst-case budget, rejected up front | 30 min, still rejected up front if the computed budget exceeds it   |
| Concurrency  | Unlimited                                 | **One per tab** — a second is rejected naming the running `flow_id` |
| Results      | In the response                           | `browser.flow_status(flow_id).manifest`, once it ends               |
| Stop         | Popup, or another agent's `flow_cancel`   | Same                                                                |

The lifecycle:

```
flow({ steps, dry_run: true })   → project it (mandatory before anything irreversible)
flow({ steps, detach: true })    → { flow_id, detached: true }
flow_status({ tab_id, flow_id }) → poll: live progress, then the manifest
flow_cancel({ tab_id, flow_id }) → stop it; lands within one step
```

`flow_status` returns
`{ flow_id, tab_id, state, detached, started_at, ended_at?, steps, steps_completed, iterations_completed?, stopped_by?, error?, manifest? }`
where `state` is `running` | `completed` | `cancelled` | `failed` |
`expired` | `unknown`.

- **The manifest is the point.** It is exactly the `results` array a
  foreground flow returns — per step, and per iteration inside a
  `repeat`. After a bulk run, _"which 956 things did you delete?"_ is a
  question the bridge can finally answer. It appears only once the flow
  ends: while it runs, the runner is still holding the results, and
  promising a manifest mid-run would promise a shorter truth than the
  real one.
- **`expired`.** A detached flow self-cancels at 30 minutes with
  `stopped_by: "expired"`. Distinct from `cancelled` on purpose: "I ran
  out of time" and "a person stopped me" call for different responses.
- **`failed` / `worker-terminated`.** Chrome can kill the extension's MV3
  service worker at any time, and a flow dies with it. browser-link
  detects this on the next worker start, marks the flow `failed` with
  `stopped_by: "worker-terminated"`, and **never resumes it**. See
  [No auto-resume](#no-auto-resume-after-a-worker-restart).
- **`unknown` is not an error.** It means this bridge has no record of
  that id — a foreground flow that already returned, a detached run
  evicted after 10 newer ones, or an id from before a worker restart.
  Same philosophy as cancelling an unknown id being a no-op.
- **`tab_id` only routes the call.** The registry is bridge-wide, so any
  connected tab can answer for any `flow_id` — a finished flow whose own
  tab has since closed is still readable through another one.
- **Poll at a human pace.** Each `flow_status` call is a full round trip
  and, for an agent, a full inference. A ten-minute run does not need two
  hundred status checks.
- **One summary event per flow.** When a detached flow ends, exactly one
  `flow-finished` entry lands in `browser.events` with counts, duration
  and outcome — never one per iteration, which would blow the 200-entry
  log and evict everything else. The manifest itself is not in the event;
  it is addressed by `flow_id`.
- **No clock cuts a running flow.** While a flow runs it holds the
  launching agent's [tab claim](#multi-agent-mode), the extension's
  [idle disconnect](#idle-disconnect-ttl) and the
  [cdp-direct connection](#cdp-direct-mode-no-extension), each for at most
  the flow's own maximum duration; when the flow ends, each clock restarts
  from its last step.

##### No auto-resume after a worker restart

The extension is an MV3 service worker: Chrome terminates it when it
looks idle, and a detached flow's loop lives in that worker's memory. A
launch record in `chrome.storage.session` is what makes the difference
between a lie and a fact — on the next worker start, any record still
marked `running` is by definition orphaned, so it is rewritten as
`failed` / `worker-terminated`, written to the popup's Recent flows, and
announced on `browser.events`. That record is a precondition, not a side
effect: if it cannot be stored, `browser.flow({ detach: true })` fails and
nothing is executed. When storage refuses it for space, browser-link drops
every already-finished record first — across **all** tabs, including
manifests no agent has read yet — and retries once: that is a deliberate
trade, because an unread manifest can still be re-derived from the page
while a missing launch record makes a killed worker undetectable.

It is **never resumed**, and that is deliberate. A detached flow exists to
do irreversible bulk work; resuming one whose real progress died with the
worker would double-act on some unknowable prefix of it. A loud failure
is the only honest option — and a flow that _looks_ `running` while
nothing is executing it is worse than either.

The partial manifest of a killed run is genuinely gone: it lived in the
runner's closure, and there is no per-step write that could have saved it
(one would mean hundreds of storage writes per run to keep a counter
warm). `manifest_truncated: true` says so rather than presenting an empty
array as "nothing happened". Re-derive what is left from the page before
relaunching anything.

##### Where a detached flow's state lives

| State                   | Where                           | Lifetime                               |
| ----------------------- | ------------------------------- | -------------------------------------- |
| The running loop        | Extension service-worker memory | Until it ends, or the worker is killed |
| Launch + outcome record | `chrome.storage.session`        | The browser session                    |
| Action manifest         | Same record, up to 128 KB       | The browser session; last 10 runs      |
| Summary event           | Server `BridgeEventLog`         | The server process, last 200 events    |

The manifest is the one place browser-link stores page-derived data
outside the persistent map: it holds resolved selectors and step results,
because that is what makes it useful. It is never shown in the popup
(whose Recent flows stay counts-and-outcomes only, same privacy contract
as always), it is only ever returned to an agent that can already read
the page, and it dies with the browser session. A manifest over 128 KB is
dropped with `manifest_truncated: true` rather than silently shortened —
a truncated array would read as "that is everything that happened".

**Persistent UI map** — local-only memory across sessions:

| Tool                     | Purpose                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `browser.map.recall`     | Recall selectors / flow notes / gotchas / named flow recipes known for an app+route                |
| `browser.map.save`       | Persist a `selector`, `flow` note or `gotcha`, and/or named flow recipes, `mechanisms`, `pitfalls` |
| `browser.map.record_use` | Mark an entry as freshly verified or failed (not applicable to named flow recipes)                 |
| `browser.map.forget`     | Delete an entry or an entire app                                                                   |
| `browser.map.rename_app` | Fix an auto-derived app_key                                                                        |
| `browser.map.apps`       | List known apps                                                                                    |

On every MCP `initialize` handshake the server pushes a structured usage
protocol to the client (when to call `recall`, what kinds to save, what
to _never_ save) — no manual prompt engineering required.

`browser.list_tabs` also surfaces the map directly: any tab whose origin
already has saved knowledge carries a `map` field (`{ app_key, entries,
flows, mechanisms, pitfalls }`). When the app's map is small (at most 5
items in total and under 2 KB serialized) the field also carries the
recalled content as `inline`, so the agent skips the round trip; bigger
maps get counts only. The usage protocol above instructs the agent to call
`browser.map.recall` for that origin BEFORE taking a fresh `browser.snapshot`
when there is no `inline` content — no separate lookup needed to know memory
already exists for that page.

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

A `selector` entry may also carry a **`semantic_key`** in its payload,
next to the selector: `{ selector, semantic_key: { role, name, path } }`,
where `semantic_key` is the one a `browser.find` single match returned for
that element (`path` has 1 to 8 `{ tag, index }` steps). Save it when the
selector is a structural `:nth-of-type(` fallback, which breaks when the
page reorders. `browser.map.save` refuses a key on an entry saved with
`ambiguous: true`. At `browser.map.recall`, a selector entry that carries a
key and whose selector is a structural fallback comes back with
`prefer: 'semantic_key'`: target it with
`browser.find({ key: payload.semantic_key })` instead of the stored
selector. `prefer` is computed at recall and never stored. The field lives
inside the existing JSON `payload`, so the `entries` table is unchanged,
there is no migration, and older rows read as before. `map export` /
`map import` carry it. `ref` values are never stored in the map: they die
with the document.

**Named flow recipes** (v0.18.0) — a separate `flows` table, one row per
named, directly **`browser.flow`-replayable** sequence, validated against
the exact `browser.flow` step grammar (`find`/`click`/`type`/`press`/`wait_for`/`drag`/`sleep`/`repeat`)
before it is ever written. `browser.map.save({ flows: [{ name,
description?, steps }] })` upserts on `(app, name)`; `browser.map.recall`
returns the app's saved recipes (`name`, `description`, `steps`,
`use_count`) alongside the entries above, unfiltered by route. The
intended loop: `recall` → **adapt** any placeholder text in `steps` (e.g.
`type text "<QUERY>"`) to the real value the user asked for → call
`browser.flow` with the adapted steps. `browser.map.record_use` does not
apply to recipes — re-saving a recipe with the same `name` refreshes it
instead.

**Mechanisms and pitfalls** — a separate `insights` table for what does
not fit a selector. A **mechanism** is how the app behaves underneath; a
**pitfall** is what does _not_ work or misleads (the most expensive thing
to rediscover). `browser.map.save({ mechanisms: [{ key, description }],
pitfalls: [{ key, description, symptom? }] })` upserts on `(app, kind,
key)`; `browser.map.recall` returns `pitfalls` first, then `mechanisms`,
then `entries` and `flows`. Delete one with `browser.map.forget({ insight:
{ app_id, kind, key } })` or `browser-link map forget <app> --pitfall <key>`
(`--mechanism <key>`). `map export` / `map import` carry them too — but
importing an export that contains pitfalls or mechanisms into an **older**
browser-link install silently drops them (older versions ignore the unknown
fields and the export version number did not change), so update both sides
before moving a map. They describe **behaviour, never content**:

| Allowed                                                               | Forbidden                                       |
| --------------------------------------------------------------------- | ----------------------------------------------- |
| "A GET of an item URL marks it complete server-side"                  | "Item 4812 is complete"                         |
| "Click on the next link returns ok but does not navigate (onmouseup)" | "User jane@example.com is enrolled in course X" |
| "Progress % is rendered client-side, not present in the fetched HTML" | Any real ID, name, date or message text         |

**Placeholder privacy rule** applies to every layer: never store domain
data (IDs, user names, dates, message content). Free text inside a
`flow` note or a flow recipe's `steps` uses a placeholder like `<QUERY>`
or `<NAME>`, never the value the user actually typed.

Each entry has `verified_at` / `failed_at` timestamps so the agent
knows whether the saved knowledge is fresh, stale, or known-broken.
When a selector that used to work suddenly fails, the agent marks it
via `record_use({ ok: false })` and stops trusting it until it relearns.

### What the map learns by itself (v0.43.0)

The layers above are written by the agent. The map also **learns from use**,
with no bookkeeping by the agent: every `browser.click`, `browser.type`,
`browser.press`, `browser.find` and `browser.wait_for` that addressed a
**durable target** adds one ok or one failure to that target's counters, in a
separate `selector_outcomes` table, per app and route.

- **The target** is the CSS selector string, or the semantic `key` of a
  `browser.find({ key })`. A call that used only a `ref` learns nothing (a
  ref dies with its document), and neither does a `find` by text.
- **Ok** means proven effect: the call carried an `expect` (so it was met),
  a `find`/`wait_for` matched, or `settle.mutation_count > 0`. A quiet call
  with none of those proves nothing and is not counted.
- **A failure** keeps one reason from a fixed list: `retargeted`, `ref-stale`,
  `expect-failed`, `not-found`, `multiple-matches`, `unmatched` (a
  `wait_for` that never matched), `timeout`, `unsettled`
  (`settle.settled: false`), `hit-mismatch` (`hit_element` is not the target).
- **Same app `list_tabs` and `recall` show**: the learner counts into the
  most recently seen app of the tab's origin and leaves it untouched (no
  `last_seen_at` bump, no title change). Only an origin with no app at all
  gets a new one, keyed and titled by the host (`app.example.com` →
  `app-example-com`). The tab title is never used or stored, so a title such
  as "Inbox (3) - My App" can never create an app that hides your saved map.
- **Bounded**: at most 200 learned targets per app; past that, the least used
  one is evicted.

What it learned comes back in two places, failures first and then the most
used:

- `browser.map.recall` returns `learned` (up to 50 items: `target`,
  `target_kind`, `action`, `ok_n`, `fail_n`, `last_reason`, `url_pattern`,
  `last_ok_at`, `last_fail_at`) right after `entries`. An app with nothing
  learned returns exactly what it returned before.
- The `list_tabs` `map` hint carries up to 3 of them in `inline.learned`,
  inside the same 2 KB inline budget and without counting toward its 5-item
  limit. When no inline map fits, the hint still says `learned_failures: n`,
  so the agent knows to look before it clicks.

**Privacy: targets only, never values.** What a `browser.type` typed, what a
`browser.evaluate` ran, which key a `browser.press` sent: none of it is ever
read by the outcome learner. Only selectors and semantic keys are stored, in
the same private, per-machine map file as everything else. (Since v0.45.0,
`browser.evaluate` expressions go to a separate JS registry with its own
privacy rules.)

It is **on by default** and independent of the activity trail. To stop it:

```bash
browser-link config get map-learning        # on (default) | off
browser-link config set map-learning off    # applies to the next action, no restart
browser-link config set map-learning on
```

Turning it off stops new learning; what was already learned stays in the map
until you `browser-link map forget` the app.

### What the map knows (v0.45.0)

What the map learned comes back to the agent at the moment it acts, with
its evidence, never as a verdict.

- **Keys.** Every learned record is keyed by the canonical origin and the
  **path pattern**: the URL path with id-like segments (digits, uuids, hex
  runs of 8+, base64url-ish tokens of 16+) replaced by `:id`, so
  `/facturas/48213` and `/facturas/7` share `/facturas/:id`. The page
  observer also reports, once the page has loaded and after each SPA
  navigation, a **build fingerprint** (a hash of the page's script and
  stylesheet URLs, query strings removed) and a **view signature** (a hash of
  its first headings and landmark roles). `list_tabs` shows both per tab as
  `build` and `view_sig`; the map keeps every build an app was seen running.
- **Confidence.** Each offered item carries `confidence` and the raw
  `evidence` (`ok_n`, `fail_n`, `last_reason`, `last_ok_build`,
  `last_fail_build`, `last_ok_at`): `fresh` (worked on the build the tab
  runs now), `unverified` (worked before, nothing on this build yet, or the
  build is unknown) or `failing` (2+ structural failures on this build since
  it last worked). Structural reasons are `not-found`, `multiple-matches`,
  `retargeted`, `hit-mismatch`, and `expect-failed` when repeated;
  situational ones (`timeout`, `unsettled`, `unmatched`, `ref-stale`) are
  counted but never change confidence. Nothing is deleted for failing.
- **The start pack.** `list_tabs` (per tab) and `navigate` (where it
  landed) carry `knowledge` when the map has evidence for that app: saved
  `pitfalls` and `mechanisms`, kept and named JS `readers`, saved `flows`,
  and the best learned `selectors` of the current path pattern (or of the
  whole app when the path has none), ranked pitfalls → fresh → unverified
  and cut to 2 KB. `failing` targets appear only under `warnings`.
- **At action time.** `click`, `type`, `press` and `find` on a selector (or
  a find key) with evidence return
  `known: { confidence, ok_n, fail_n, last_reason, alternative? }`, where
  `alternative` is the best fresh target for the same action on that path.
- **The whole map.** `browser.map.recall({ origin, scope: 'app' })` returns
  everything for the app: entries, flows, mechanisms, pitfalls, every JS
  registry row, every learned target with counters, builds and confidence,
  the build history and `learned_failures`; `scope: 'all'` does the same for
  every app of the origin. The default (`scope: 'path'`) is unchanged.

### Closing the loop: wrap_up

Everything above is recorded automatically. What is worth **keeping** is
decided by the agent, once, before it answers you: it calls
`browser.wrap_up` twice.

1. **No arguments** — per app the session touched (≤ 2 KB): the pending JS
   readers (`id`, the first 160 characters of the expression, `kind`,
   `flags`, counters, average result size), the flows it ran, the targets it
   learned, friction by reason, and **pitfall candidates** the server wrote
   from repeated structural failures ("click on `.next` was retargeted 3
   times on build 3f9a").
2. **With decisions** — `{ readers: { keep: [{ id, name, template? }], drop },
flows: { keep: [{ session_index, name }] }, pitfalls: { confirm, drop },
feedback: [{ tool, observed, expected }] }`. The server checks every item
   against the eight rules below and applies the accepted ones in **one
   transaction**: a crash midway leaves the map exactly as it was. The answer
   lists `applied` and `rejected: [{ item, rule, reason }]`; anything not
   decided stays pending and is offered again next time.

From the first successful `evaluate` or `flow` of a session, every object
result carries `pending_wrap_up: n` until the decisions are committed. The
first browser call of a session also returns the rules as a second text
block, so an agent that never read its instructions still gets them.

**The eight rules, enforced server-side** (each rejection names its number):

1. Only what worked: `ok_n ≥ 1` and the last outcome ok.
2. A reader holding data literals is kept only as a `<PLACEHOLDER>`
   template, which may differ from the expression only inside strings.
3. Nothing touching credentials, tokens, cookies or storage; a mutation is
   never kept as a reader.
4. Names say what is returned: kebab-case, ≤ 40 characters, no leading
   `get` / `set` / `do` / `run` / `make`, unique per app.
5. One-offs are dropped by default (a named one may be kept).
6. Pitfalls only from the server's candidates, by id, ≤ 200 characters —
   never free text.
7. Nothing about the user: no name, template, flow step or feedback holding
   something typed in the session.
8. In doubt, drop: `drop` is always accepted and wins over `keep`.

The server never rewrites an expression; a kept reader stores its template
next to the original.

**Shortcuts that use what was kept:**

- `browser.read({ tab_id, name | id, values? })` runs a kept reader of the
  tab's app, filling its placeholders (values are escaped as string
  content; a missing one fails before anything runs), returns the raw value
  like `evaluate` and counts the outcome on the reader.
- `browser.flow({ tab_id, name, values })` replays a saved flow with its
  placeholders filled. On inline `steps`, `values` fills placeholders and
  `name` marks the run as a candidate that `wrap_up` can save.
- `browser.evaluate({ ..., as: 'invoice-total' })` names the registry row
  right away; it stays pending until `wrap_up`.
- `browser.feedback({ tool, observed, expected })` leaves you a local note
  about a tool that misbehaved (`browser-link feedback` lists them); the
  agent never opens an issue.

`browser-link map show <app>` prints the builds, the learned targets with
their confidence and the JS readers after the flows.

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

CREATE TABLE insights (
  id, app_id,
  kind TEXT,                     -- 'mechanism' | 'pitfall'
  key, description, symptom,     -- symptom: pitfalls only, optional
  created_at, updated_at
  -- UNIQUE(app_id, kind, key)
);

CREATE TABLE selector_outcomes (  -- v0.43.0, written by the learner only
  id, app_id, url_pattern,
  target,                        -- CSS selector, or a find semantic key as JSON
  target_kind TEXT,              -- 'selector' | 'key'
  action,                        -- click | type | press | find | wait_for
  ok_n, fail_n, last_reason,     -- last_reason: fixed failure enum
  last_ok_at, last_fail_at
  -- UNIQUE(app_id, url_pattern, target, target_kind, action)
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

1. In the popup, check **"Enable flow recording"** (a settings toggle
   below the Connect button).
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
  `browser-link config get/set flow-recording`. Last write wins: the popup
  and the CLI each stamp an `updatedAt` on every change, and the extension
  applies a value pushed by the server only when it is newer than its own.
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

## Downloads

A plain `browser.click` on a Download button can open Chrome's native
"Save as" dialog (when "Ask where to save each file" is on). Nothing in CDP
or the page can press that dialog, so an agent gets stuck. `browser.download`
never lets it appear:

- `browser.download({ tab_id, selector })` clicks the element and catches
  the download Chrome starts in `chrome.downloads.onDeterminingFilename` —
  which Chrome consults _before_ it prompts — by holding it there, so Chrome
  cannot prompt and the download does not complete. The held download's URL
  is then fetched like the `url` mode below. Chrome's own download is
  cancelled and erased only after the file is saved, and only when the file
  fetched again is certainly the same one (see below).
- `browser.download({ tab_id, url })` fetches an http(s), `blob:` or
  `data:` URL in the page, with the page's cookies.

The server writes the bytes into the downloads directory and returns
`{ ok, state: "complete" | "interrupted" | "timeout", path, filename, bytes, mime, url, error?, chrome_download?, mark_of_the_web? }`.
Timeouts and failures still report what is known (URL, MIME type, bytes
received so far). `browser.events` gets `download-started` and
`download-finished` entries.

**Which download a selector capture takes.** Chrome's download list gives no
tab, so the capture takes a download only when the clicked tab's own debugger
session reported it (`Page.downloadWillBegin`) during the wait with the same
URL, no extension started it, and no other download with that URL appeared in
the wait. Any other download that appears while it waits is left alone: it is
not held, paused, cancelled or erased. When a download appeared but none could
be tied to the tab with certainty, the tool answers
`ok: false, state: "interrupted"` with an `error` starting "the capture
failed" and `chrome_download: "left_in_chrome"`; the file is not saved. The
agent can pass the file's link as `url`, or ask you. When nothing appeared the
state is `timeout`.

**Nothing is erased on a doubt (selector mode).** The server fetches the
captured download a second time, with GET. Before it saves that file, and so
before Chrome's own copy may be erased, it compares the second fetch with what
Chrome reported for its download: the exact size, the MIME type (when Chrome
knew it) and the final URL. When anything differs (a server that answers 200
with an HTML error page, a one-time link that now redirects to a login page, a
different file), or when Chrome did not report the size (no `Content-Length`,
or an extension older than the server), the second fetch cannot be proven
identical: nothing is saved and Chrome's download is left untouched: the call ends
`ok: false`, `state: "interrupted"`, `chrome_download: "left_in_chrome"`, with "the
capture failed" and every difference in `error`; use Chrome's own copy, in its
downloads list (chrome://downloads). Chrome does not report which HTTP method
started a download, so a download produced by a POST cannot be recognised
directly: fetched again with GET it gets an error status, another page or
other bytes, and fails the comparison. A capture that does report a method
other than GET is never fetched again.

**What happens to Chrome's own download (`chrome_download`, selector mode).**
The extension holds the captured download until the server says whether the
file was saved:

| `chrome_download` | What you see in Chrome                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `removed`         | Nothing: the file is saved, and Chrome's copy was cancelled and erased from its list.                                                                      |
| `cancelled`       | The file is saved; Chrome's list still shows the download as cancelled, because the erase failed.                                                          |
| `left_in_chrome`  | The download carries on as if browser-link had not been there; Chrome may ask where to save it. If the file was saved too, you have two copies.            |
| `unknown`         | What became of Chrome's copy is not known (see below). A saved file then carries `chrome_download_note`: there may be a second copy in Chrome's downloads. |

`left_in_chrome` is the answer when the extension held the download and the
fetch or the write failed (nothing is erased), when the capture could not
attribute the download, and when a second download with the same URL appeared
while the first was held (the two cannot be told apart, so Chrome's copy is
never cancelled). `unknown` appears when the server's settle message was
lost, or when the extension no longer held the download (an unknown id, one
already settled, or a hold that expired and was released: it answers
`not_held`, which the server reports as `unknown`). The extension releases a
download it still holds untouched when its hold expires (the call's
`timeout_ms` plus 30 seconds). The values an agent can see are `removed`,
`cancelled`, `left_in_chrome` and `unknown`. When a save fails, the error ends
with what happened to Chrome's own copy.

`browser.download` refuses files over 25 MiB by default. Change the cap with
`browser-link config set downloads.max-mb <1..64>` (`default` restores
25 MiB); `browser-link config get downloads.max-mb` shows it. 64 MiB is the
ceiling because the file crosses the extension socket base64-encoded in one
message. The change applies to the next download without a restart, and a
file over the cap comes back as `interrupted` with the active cap named in
`error`.

```bash
browser-link config get downloads.dir                   # default: <data dir>/downloads
browser-link config set downloads.dir /home/me/agent-dl # absolute paths only
browser-link config set downloads.dir default
```

Only you choose the directory: an agent's `filename` must be a plain
basename (no separators, no `..`), and an existing file is never
overwritten (`report (1).csv`).

**Executable files are refused.** A file whose name ends in a type that runs
or installs when opened (`.exe`, `.msi`, `.bat`, `.cmd`, `.com`, `.ps1`, `.lnk`,
`.scr`, `.js`, `.vbs`, `.hta`, `.jar`, `.reg`, `.msix`, `.sh`, `.dmg` and similar; any
case, judged by the last extension, so `invoice.pdf.exe` is an `.exe`) is
not written: the call ends `ok: false` and `error` names the setting. Whether
the name came from the agent or the page does not matter. Only you can allow
them, from the console (the Admin window shows the setting read-only):

```bash
browser-link config set downloads.allow-executables on   # off (the default) refuses them again
browser-link config get downloads.allow-executables
```

**Mark-of-the-Web on Windows.** Every file the server saves on Windows gets
the same `Zone.Identifier` alternate data stream Chrome writes on its own
downloads (`ZoneId=3`, the Internet zone, with `ReferrerUrl` the page and
`HostUrl` the download when they are http(s) URLs; a `data:` or `blob:` URL is
left out), so SmartScreen and Office Protected View treat it as coming from
the web. The result says `mark_of_the_web: "written"`. Where the stream cannot
be written (a FAT or exFAT drive, some network shares) the file is kept and
the result says `mark_of_the_web: "failed"` with the reason in
`mark_of_the_web_error`. Other systems get no such field.

Why not just tell Chrome to save without asking? Because an extension
cannot: Chromium answers `Browser.setDownloadBehavior` and
`Page.setDownloadBehavior` with "Not allowed" for `chrome.debugger`
clients, and `chrome.downloads.download({ saveAs: false })` still prompts
when the user's "Ask where to save" setting is on. Fetching the file a
second time in the page sidesteps both — with these limits:

- A download produced by a one-shot POST form or a single-use token cannot
  be fetched again; it comes back `interrupted` with the HTTP error or the
  difference from what Chrome reported, and Chrome keeps its own copy.
- A `blob:` URL the page revoked right after the click is gone.
- 25 MiB per file.
- `chrome.downloads` gives no tab id, so selector mode never guesses: a
  download is taken only on the tab's own report, as described above. A
  download the tab cannot report is never attributable, so the call fails and
  Chrome keeps it: one that opens in a new tab or window, one started by a
  cross-origin iframe, one started by a service worker, and the same URL
  downloaded twice during the wait. For those, pass the link as `url`. Only
  one `browser.download` can wait at a time.
- On cdp-direct tabs only `url` mode works.

**The file is written under a temporary name.** The server writes the bytes
to `.browser-link-<random>.part` in the downloads directory, then links it to
the final name, so a write that fails halfway leaves no file under that name.
The temporary file is removed on every path. An existing file is never
overwritten, whatever the file system: where hard links are not supported
(FAT, exFAT, some network shares) the server copies the file instead, which
is not atomic.

**Extension and server of different versions.**

| Extension | Server | Selector mode                                                                                                                                                                                                                                                                                 |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new       | new    | As described above.                                                                                                                                                                                                                                                                           |
| new       | older  | The server never settles the held download, so the extension releases it untouched after the hold expires: the file is saved and Chrome carries on with its own copy as well. A download that cannot be attributed is reported as `timeout`. An older server reads `not_held` as unknown too. |
| older     | new    | The older extension cancels and erases Chrome's download before the server fetches it, takes downloads by referrer and timing, and sends no id to settle; no `chrome_download`.                                                                                                               |

`browser.list_tabs` marks an extension older than the server with
`extension_outdated: true`, and one newer than the server with
`extension_newer: true`; either comes with `version_note`, which names what
does not work until the extension is reloaded or the server restarted.

## Activity trail

Every browser tool an agent dispatches is recorded — what it did, where, on
whose behalf, and whether it worked. The trail lives on disk, so it survives
closing Chrome and restarting the server.

Open it from the extension popup: press **Activity**.

That opens a real window, not a panel inside the 320px popup — a Chrome
action popup closes the moment it loses focus, so it physically cannot be
watched while an agent works. This one stays open and can sit on a second
monitor.

| Column     | What it holds                                                             |
| ---------- | ------------------------------------------------------------------------- |
| **When**   | Relative time; hover for the exact ISO timestamp                          |
| **Agent**  | Self-declared claim label (`claude-code`, `opencode`); hover for the pid  |
| **Tool**   | Full tool name, with a `flow` badge when the action was a step inside one |
| **Target** | Selector, then payload, then URL — whichever the tool actually acted on   |
| **Result** | `ok · 88ms`, or the error message. Failed rows are tinted                 |

Filter by agent, by tool, or to failures only; the search box filters what is
already loaded, so typing is instant. **Live** keeps the newest actions
streaming in (and pauses itself when the window is hidden). **Export** hands
you the visible rows as NDJSON.

### Size, always on screen

A strip under the header shows, at all times: **how many actions** are stored,
**how much disk** they take, **the oldest entry**, and a meter of how close the
trail is to its 50,000-row ceiling. The meter turns amber past 80% — the point
where the next actions start pushing the oldest ones out, and therefore the
moment to decide between purging and exporting first.

The size is the real file set on disk: `activity.db` **plus its `-wal` and
`-shm` sidecars**. Reporting only the `.db` would understate a busy trail
badly, because WAL mode parks recent writes in the sidecar until a checkpoint.

### Purging

Press **Purge…** in that strip. Pick a date range — or one of the presets
(_older than 30 days_, _older than 7 days_, _everything_) — and the panel walks
you through two steps:

1. **Check how many.** Resolves the exact count for the range you picked:
   _"This will permanently delete 4,812 of 12,483 actions."_
2. **Delete permanently.** Disabled until step 1 has run, and it re-disables
   itself the moment you change either date — so the red button can never act
   on a count from a range you are no longer looking at. A final modal
   confirmation names the number one more time.

It is permanent. Deleted rows are not in a recycle bin and are not recoverable
from an earlier export unless you already made one. Export first if in doubt.

Purging reclaims the disk space rather than just marking rows dead: the purge
checkpoints the WAL, `VACUUM`s, and checkpoints again. Without that sequence
you would delete half the trail in WAL mode and watch the reported size not
move — which reads exactly like a purge that did nothing.

The same thing from the terminal:

```bash
browser-link activity stats                          # rows, size, oldest, newest
browser-link activity clear --to 2026-07-31          # counts first, asks for --yes
browser-link activity clear --from 2026-07-01 --to 2026-07-31 --yes
browser-link activity clear --from 2000-01-01 --yes  # every row, then reclaim the space
```

Every form of `activity clear` that goes ahead (a date range, `--older-than`,
or the whole trail with `--yes`) compacts the database file afterwards, so the
deleted text is gone from disk. If the compaction fails, the command says the
rows were deleted but the file could not be compacted, and exits 1.

### Friction report (v0.43.0)

The trail also answers "what went wrong in this session" in one call, without
reading it row by row. Each row now keeps the evidence that used to vanish
when a call resolved `ok`: a `flag` (`retargeted`, `ref-stale`,
`expect-failed`, `timeout`, `unmatched`, `not-found`, `multiple-matches`,
`flow-timeout`, `download-timeout`, `unsettled`, `hit-mismatch`) and the
agent session that ran it.

- **Agents** call `browser.activity({ summary: true })`, optionally with
  `since` (ISO timestamp), `since_id` or `agent_id`; any other filter
  alongside `summary: true` is an error naming it, never silently ignored. It returns
  `{ summary: { records, errors, by_flag, by_tool_errors, evaluate_calls,
timeouts, top_failing_targets, sessions } }`: the top 10 failing selectors
  with their tool and last flag, and one line per agent session. Without
  `summary`, `browser.activity` returns the same rows as before, and also
  honours `since` and `agent_id`.
- **You** run `browser-link activity report [--since <duration|iso>]
[--agent <id>]` for the same report as a table.

Like the map's learner, the report works on targets and counts; it never
needs the typed text or evaluate expressions that payload recording keeps.

### Reading it outside the browser

The window is for watching. For archiving, grepping, or handing the trail to
another agent, use the CLI — no browser in the loop:

| Command                                                         | What it does                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `browser-link activity`                                         | Recent actions, newest first                                             |
| `browser-link activity --failed`                                | Only what errored                                                        |
| `browser-link activity --agent opencode --tool browser.click`   | Filter by agent, tab, tool, flow or outcome                              |
| `browser-link activity export --out run.ndjson --format ndjson` | Whole trail to a file (`json`, `ndjson` or `csv`)                        |
| `browser-link activity export --redact`                         | Same, with payloads, titles and URL query strings stripped               |
| `browser-link activity stats`                                   | Rows stored, size on disk, oldest and newest entry                       |
| `browser-link activity clear --older-than 7d`                   | Trim history. Without `--older-than`, `--yes` is required                |
| `browser-link activity clear --from 2026-07-01 --to 2026-07-31` | Purge a date range: counts first, needs `--yes`, reclaims the disk space |

Agents read it through **`browser.activity`** — useful for checking your own
work before reporting it, or for seeing what a different agent did to a tab
you just claimed. Pass `include_payloads: false` to get the shape of a long
run without pulling every typed string into context.

> `browser.activity` is not `browser.events`. Events are bridge **lifecycle**
> (a tab connected, a dialog opened), 200 entries, in memory, gone when the
> process exits. The activity trail is what agents **did**, on disk, across
> restarts.

### What is recorded, and what leaves your machine

Rows carry the free text an action moved: the string `browser.type` typed, the
expression `browser.evaluate` ran, the URL `browser.navigate` went to. That is
deliberate — a trail that cannot tell you what an agent typed answers none of
the questions people open it for.

Three things keep that honest:

- **Nothing uploads it.** The trail is a SQLite file in your data dir
  (`activity.db`, beside `map.db`), read over loopback and never sent anywhere.
- **Redaction happens on the way out, with one exception decided by the page.**
  You keep the full trail; `--redact` is what you run when handing it to
  someone else. The exception: when `browser.type` or `browser.press` acts on
  a field the page itself declares sensitive (a password input, or an
  `autocomplete` of `current-password`, `new-password`, `one-time-code`,
  `cc-number` or `cc-csc`), or on a field it never identified, and
  `activity.hide-sensitive` is on, the row stores `[sensitive field]` (or
  `[field not identified]`) in `payload` with `record-payloads` on or off, and
  the typed text is removed from `url`, `title`, `selector` and `error` too (see
  [The activity trail](#the-activity-trail)). With the setting off such rows
  are stored like any other. Rows stored earlier are not changed.
- **It is not complete.** Detection relies on what the page declares, so
  `evaluate` expressions, plain text fields, `press` on unmarked fields, URLs
  with query strings, fields in cross-origin iframes, closed shadow roots and
  `contenteditable`, text typed by an earlier call that a later row echoes,
  and flow rows are stored as typed. Other agents (`browser.activity`) and
  bridge clients can read the payloads. The full list is under
  [Upgrading to 1.0](#upgrading-to-10).

If you would rather not record the text at all:

```bash
browser-link config set activity.record-payloads false   # keep the shape, drop the text
browser-link config set activity.enabled false           # record nothing
browser-link config set activity.hide-sensitive off      # store sensitive rows unhidden (restart to apply)
```

With `record-payloads` off, every row still says which tool ran, where, by whom
and with what outcome — only the payload column goes.

The trail keeps the most recent 50,000 actions and prunes the oldest beyond
that. That ceiling is sized for the runs actually worth auditing: a single
`repeat` step can dispatch hundreds of actions, so a small buffer would evict
the morning by lunchtime.

## Customising

A handful of knobs — some on by default, all reversible.

### Extension language

The extension (popup, **Activity** and **Admin** windows, product notice) is
available in English and Spanish. Switch with the **EN | ES** selector at the
far right of each window's header, on the line of the title and version; the
choice is remembered, and windows that are already open follow it at once.
Until you pick one, it follows the browser's language. It is separate from the
console's language (`language` in `config.json`, shown as **Console language**
in the Admin panel), which the selector does not change.

### Admin panel (console and popup)

The console's status view and the popup's **Admin** window render one
description the server builds: the same sections (status, setup, diagnose,
reference), options and labels. The console localises them from `language` in
`config.json` (English or Spanish); the Admin window asks for the
[extension's language](#extension-language) instead. The popup's **Admin** button opens the panel in its own
window, like **Activity** (pressing it again focuses the open one), so it
stays on screen while you change settings. The window asks the running server
over the extension's existing connection, so it needs at least one connected
tab; without one it says so.

From the Admin window you can switch the console language; toggle multi-agent,
auto-reelect, the instructions auto-refresh and the activity trail; run `doctor`
and an update check; and install or remove the instructions block per client.
Since 1.0.0 it only **shows** the settings that widen what an agent may see or
do. Since 1.3.0 they all sit in their own section, **Console settings**
("Ajustes de la consola" in Spanish): each MCP tool, cdp-direct on or off, its
port and grant lifetime, the two hide settings (password values, sensitive
values in the trail), the downloads folder, whether `browser.download` may save
executable file types, the idle disconnect, the claim expiry between agents and
MCP client registration. One notice at the top of the section says once why
they are not changed there: each one widens what an agent may do or see, so
anything that can reach the bridge, an agent included, could otherwise grant
it. Each row shows the current value and the exact console command that
changes it (`browser-link tools disable <tool>`,
`browser-link config set cdp-direct.enabled true`,
`browser-link config set cdp-direct.port <port>`,
`browser-link config set cdp-direct.grant-ttl <minutes>`,
`browser-link config set hide-password-values <on|off>`,
`browser-link config set activity.hide-sensitive <on|off>`,
`browser-link config set downloads.dir <absolute-path|default>`,
`browser-link config set downloads.allow-executables <on|off>`,
`browser-link config set idle-ttl <minutes|never>`,
`browser-link config set claim-ttl <minutes|never>`,
`browser-link install --client <id>`) with a **Copy** button; nothing is behind a
hover. The server refuses a write for any of them if one arrives, with or
without a confirmation code. Turning either hide setting off widens what an
agent can read, so the rule covers both. See
[Upgrading to 1.0](#upgrading-to-10). The rules:

- **Every change that writes to disk asks first.** The server answers with a
  one-line preview (for example "Turn off: Record the activity trail") and
  applies it only after you confirm. Each preview carries a single-use code,
  bound to that exact change and valid for two minutes. The server applies the
  change only with that code: a `confirm` flag alone writes nothing, and a
  changed value, a second use or an expired code is refused. The forced update
  check writes `update-check.json`, so it asks first. `doctor` runs straight
  away.
- **What the code does not prove.** It stops one-frame writes, replays and a
  value changed after the preview. It does not prove that a person clicked.
  A process that has already passed the bridge's checks runs as your OS user
  and could already edit `config.json` by hand. The update check that starts
  when the Admin window opens can refresh its own cache file,
  `update-check.json`, without a code.
- **Same write path as the CLI.** The server applies a change through the
  helpers `browser-link multi-agent`, `config set` and `instructions` use,
  with their validation, and accepts only the entries it described: an unknown
  action or value is refused.
- **Some changes need a restart.** Multi-agent, auto-reelect, the
  instructions auto-refresh and the activity settings are read when the
  server starts; the panel says "restart required".
- **Never from the popup:** stopping the server (`browser-link stop`) and
  updating it (`npm install -g @jobshimo/browser-link@latest`) end the very
  server that answers the popup, so they appear as the console commands to
  run. The same goes for every setting in Console settings (above), shown
  with their console command; flow recording keeps its own popup control.

### Agent instructions

Having the MCP tools registered is necessary but not sufficient. Agents
reach for what their instructions point at — out of the box they have no
reason to call `browser.snapshot` when you say "the button is broken". The
manual reaches the agent through three channels, all rendered from one
source in the server:

1. **Connect-time core** (`initialize.instructions`). The core is at most
   2,000 characters (2,300 with the refresh notice), and it comes first in
   that text because hosts truncate it. It holds only what must change
   behaviour from the first call: when to look at the browser, the rules that
   avoid wasted calls, and where the rest is. The first browser tool call of
   each agent session returns the same rules as a second text block.
2. **Installed block** (a trigger of under 600 characters; with
   `--with-core`, the trigger plus the core, about 2,700 characters).
   `browser-link instructions install` writes it, fenced by HTML-comment
   markers with a version stamp, into the agent's **global** instructions
   markdown. The trigger says what browser-link is and when to use it. The
   core joins it in the file only with `--with-core`; the block records that
   mode and the start-time refresh keeps it:

   | Client             | File                                                 |
   | ------------------ | ---------------------------------------------------- |
   | Claude Code        | `~/.claude/CLAUDE.md`                                |
   | OpenCode           | `~/.config/opencode/AGENTS.md`                       |
   | GitHub Copilot CLI | `~/.copilot/AGENTS.md` (override via `COPILOT_HOME`) |

   Reinstall overwrites in place. Install puts exactly one line end before the
   block, none into an empty file. Uninstall removes the block and, when the
   block is last in the file, the one line end install put before it, and
   nothing else: blank lines and a missing final newline in your text stay as
   they are. Everything else in the file is kept byte for byte, and a file with
   CRLF line ends keeps them. The write is atomic and makes no backup copy.
   A file that is not valid UTF-8, or that holds a begin marker with no end
   marker after it, is refused and left unchanged; the message says what was
   found. `browser-link doctor` shows `⚠ outdated` until you re-run install
   or the server refreshes it at its next start.

3. **`browser.manual` on demand.** No arguments returns the index (server
   version, the block status per client, one line per tool, the topic list);
   `{ tool }` returns one tool in full; `{ topic }` returns one topic. It
   needs no tab.

**Refresh at start.** When the server starts, every client whose block is
installed but older than the server is refreshed in place, through the same
atomic write `browser-link instructions install` does; installing once is the
opt-in. A client without a block, or whose file is corrupt, is never touched:
not installing is a choice. When a block was refreshed, the first line of the
connect-time text says
`Your browser-link instructions block was updated to v<version> for <clients>: restart the client to load it.`
and the server logs each outcome to stderr. If a refresh fails, that client
keeps the **outdated notice** (the first line names the command to run) with
the reason appended. To keep your blocks exactly as they are, set
`"instructionsAutoRefresh": false` in `config.json` in the data dir; the
server then never writes those files and only shows the outdated notice.

### Per-tool permissions

`browser-link` exposes **40 MCP tools** — 34 bridge tools that drive the
connected Chrome tab, read the activity trail or the manual, or close the
knowledge loop, and 6 to read/write the persistent UI map (2 read, 4 write).
**All 40 are individually toggle-able** (`browser.activity` joined the list
in 0.44.0; the `readonly` preset keeps it on and turns off `browser.read`,
`browser.wrap_up` and `browser.feedback`), so you can narrow the surface
per machine:

- **In the menu** → `Permissions`. Toggle individual tools with **Space**
  or apply a preset with **Enter** (`all` / `readonly` / `no-eval` /
  `no-map`). Press **s** to save.
- **From the shell**:

```bash
browser-link tools                              # current state of all 40 toggle-able tools
browser-link tools disable browser.evaluate     # block JS execution
browser-link tools disable browser.reset        # block destructive soft-reset
browser-link tools disable browser.set_permission   # block permission grants
browser-link tools preset readonly              # observation-only profile
browser-link tools enable browser.click         # turn one back on
```

Presets, in plain English:

| Preset     | What it disables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`      | Nothing — every tool enabled (default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `readonly` | The 17 non-read bridge tools (`navigate` / `click` / `type` / `press` / `drag` / `flow` / `flow_cancel` / `dialog_respond` / `set_permission` / `download` / `claim_tab` / `release_tab` / `reset`, plus `evaluate` / `read` / `wrap_up` / `feedback`) and the 4 map-write tools (`save` / `record_use` / `forget` / `rename_app`) — 21 disabled. Leaves the 17 read bridge tools and the 2 map-read tools (`recall` / `apps`) — 19 tools total. Note `flow_status` stays ON: watching what a flow is doing is observation, and an operator locked out of it could not see a runaway they are not allowed to start. |
| `no-eval`  | Just `browser.evaluate`. Everything else stays on — useful for "agent can drive but cannot run arbitrary JS".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `no-map`   | All 6 persistent-map tools. Bridge tools stay on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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
only Node-family binaries run by the same OS user as the server that present a
fresh token from `config-dir/multi-agent-token` are accepted. Strict mode by
path (`peerExecutablePaths`) applies to the WebSocket port only, not to this
one.

**Auto-reelect on primary close**: if the primary's MCP client closes,
secondary proxies enter a reconnect window of two full reconnect attempts
(24 seconds by default) — in-flight
requests get a `-32001 "temporarily unavailable"` envelope while the
proxy waits for the new primary to bind the WS port. When it appears,
the proxy hot-swaps and traffic resumes.

**Traceability — `browser.events`**: every primary keeps an in-memory
ring buffer of bridge events (`primary-elected`, `tab-registered`,
`tab-disconnected`, `tab-renamed`, `tab-claimed`, `tab-released`,
`tab-claim-rejected`, `flow-recorded`, `flow-finished`). When a tool call fails with "Tab not connected:
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

An agent may pass its own TTL (`ttl_minutes`, at most 60). Without one, the
claim follows your console setting `claim-ttl`: 10 minutes by default,
`browser-link config set claim-ttl <minutes>` (1-1440) to change it,
`never` so a claim lasts until its agent releases it or disconnects, and
`default` to go back to 10. It is read on every check, so a change applies
without a restart, and a claim reports it as `ttl_ms` (`null` for never). It
widens what an agent may do, so only the console changes it; the Admin window
shows it read-only. A running `browser.flow` holds the claim of
the agent that launched it: while the flow runs the claim cannot expire, and
when the flow ends, however it ends, the TTL restarts from the flow's last
step. The hold is bounded by the flow's own maximum duration (its time
budget, at most 60 s, in the foreground; 30 minutes when detached): past it
the TTL restarts from that bound. A detached flow's hold ends with its
`flow-finished` event. Only the claim of the flow's own agent is held;
another agent still gets the usual conflict. A long single call, such as a
`wait_for`, holds no claim: the TTL counts from the call that started it.
Claims live in the primary's memory, so after a primary restart no claim and
no hold survive, and a detached flow still running in the extension is
unclaimed until an agent acts on its tab.

### Updating while a server is running

An `npm install -g @jobshimo/browser-link` replaces the files on disk, but
a server that is already running keeps the code it started with. Since
0.41.0 an old server can no longer keep serving after an update:

- **The newer process wins the port.** When a browser-link starts and
  finds `127.0.0.1:17529` taken, it retries the bind briefly (a hand-off
  may be in progress), then asks the running primary
  `GET http://127.0.0.1:17529/version` (`{ name, version, pid, startedAt,
installedVersion, repairing, sessions? }`; answered only when the `Host` header is
  `127.0.0.1`, `localhost` or `[::1]`, with or without a port, else
  `403`, so a web page reaching the port under its own host name never
  reads it). If the primary is older, it is stopped (Unix
  `SIGTERM`, then `SIGKILL` after 3 s; Windows `taskkill /F`) and the new
  process binds in its place. The pid in that `/version` body is only a claim:
  before it stops anything, the new process asks the operating system (Windows
  `netstat`, macOS and Linux `lsof`) which process listens on the port, and
  stops it only when that process is the one the primary named, runs under a
  Node-family runtime and its command line runs this package as a server. If
  the operating system cannot be asked, names another process, or shows a
  process that is not a browser-link server, nothing is stopped: the new
  process defers, and the [server log](#what-now-stops-a-connection) names the
  holder (PID and name) and the command `browser-link stop --pid <PID>` that
  stops it. When the lookup itself failed, the log says so and points to
  `browser-link stop`. A primary from before 0.41.0 has no
  `/version`: it is replaced when its process started before the installed
  `dist/cli.js` was last written, because then it is necessarily running
  stale code. Same or newer version: nothing changes (proxy in multi-agent
  mode, the usual "port in use" error otherwise), except a same-version
  primary that reports `repairing: true`: it is handing the port over to
  this very process, so the bind is retried for up to 5 s instead. A
  step-down never targets the starting process itself or one of its
  ancestors (the shell or MCP client that launched it). The connected tabs
  reconnect by themselves.
- **`browser-link stop` stops only what the operating system confirms.** It
  asks the operating system which process listens on port 17529 and on the IPC
  port 17530, and stops a holder only when it is a browser-link server: a
  Node-family runtime whose command line runs this package with no subcommand
  (or `start`). It never touches itself or the shell that launched it. It says
  the port is "already free" only when that lookup ran and found no listener;
  if the lookup failed, it says so, stops nothing and exits with code 2.
  A holder that is not a browser-link server is left running and shown with its
  PID, name and the command to stop it. Other processes that only look like a
  bridge (proxies, strays, a setup UI in another console) hold no port the
  operating system can confirm them by: `stop` lists each with its command and
  does not stop them.
- **`browser-link stop --pid <PID>` stops exactly one process you name.** It
  prints the process as the operating system reports it, then stops that one
  process, in one step with no `--yes`. It refuses, stopping nothing, when the
  operating system does not list the PID, when the PID is this command or one
  of the processes that started it, or when the process neither holds port
  17529 or 17530 nor runs as a browser-link server. A PID that is not a
  positive whole number is refused with exit code 2.
- **"Running X / installed Y" is visible everywhere.** `browser-link
doctor` prints `running 0.37.0 (pid 40296) / installed 0.41.0 → outdated`
  with what to do, and lists the live browser-link processes;
  `browser.list_tabs` adds a hint for the agent when the server is
  outdated; the extension popup shows "Server running X · installed Y".
- **"Repair connection" in the popup.** It asks the running server to
  restart itself on the installed code: the server answers, starts the
  installed CLI detached, closes every extension socket and exits; the new
  process takes the port and the extension reconnects. With no server
  running, the popup reconnects the remembered tabs; a server older than
  0.41.0 cannot repair itself, so the popup tells you to run
  `browser-link stop` and restart your agent. A repair also ends the MCP
  server process of the client that started it; the client starts a new
  one. The server hands over only once the new process has really
  started: if starting it fails, even asynchronously, the failure is
  logged and the running server keeps serving.
- **The console's Updates screen asks before it touches anything.** When a
  newer version exists, `u` reads what the update would touch and shows it:
  the running server and its version, how many agent sessions use it, what
  will be stopped and why, and that other browser-link processes are not
  stopped. Nothing runs until you answer `y`; `n` or Esc backs out. The count
  comes from an optional `sessions` field of the primary's `/version` body:
  its own MCP client while connected, plus the proxies that passed the IPC
  handshake. A primary that sends none (older than this field) makes the
  screen say the number cannot be read. The install (`npm install -g` of the
  chosen version) is asked to stop after 10 minutes at most, and `c` cancels it
  sooner; leaving the screen during an install cancels it the same way. A
  cancel or the time limit only asks npm to stop: the tool cannot confirm that
  it ended (it can end only the process it started, and on Windows that may be
  the shell that launched npm), so the result says npm may still be running,
  to check for a leftover npm or node process (Task Manager on Windows, `ps`
  on macOS and Linux), and to run `npm install -g` again once it is gone. The
  result lists everything that was stopped, whether it installed, npm's own
  error lines when it failed (not the log path npm prints last) and the next
  step. Once an update has finished, `u` does nothing.
- **"Installed" means the version on disk was read back.** Before npm runs,
  the console closes the databases it opened (Doctor and the map screens open
  the map), and npm runs in your home directory, not the directory the console
  was started from. After npm exits without an error, the console asks the
  same npm for its global folder (`npm root -g`) and reads the installed
  package's version there. Only that version decides the result: another
  version than the one requested is a failure, and a version that cannot be
  read leaves the update unconfirmed; both say to run `npm install -g` and
  `npm ls -g` in a terminal. A confirmed install ends with the last step:
  reload the extension in `chrome://extensions`. The console cannot see the
  extension, so it does not check that; once a tab reconnects, the popup and
  `browser.list_tabs` report a skew in either direction.
- **A server is stopped only on Windows.** A running primary has loaded the
  package's native module (better-sqlite3) once it opened its map or activity
  database, and Windows keeps a loaded module's file locked, so npm cannot
  replace the package. The update then stops that one server; the agents using
  it lose browser-link until their MCP client restarts, and the first client
  to start runs the new version. On macOS and Linux npm replaces files a
  running process has open, so nothing is stopped: the running server keeps
  the old version until its MCP client restarts, and the next server to start
  takes the port over. Proxies hold no database and other browser-link
  processes (other consoles, agents connected through the server) are never
  stopped on any system. If one of them still locks the package on Windows,
  the result says so: close every browser-link console and MCP client, then
  run `npm install -g @jobshimo/browser-link` yourself in a new terminal.
  Closing a database does not release that lock: Node never unloads a native
  module. When the console itself loaded it (Doctor or a map screen opened the
  map), the update on Windows refuses before stopping or installing anything:
  close the console, run `browser-link stop` in a new terminal (it does not
  open the map), close your MCP clients, then run `npm install -g` yourself.

### Idle-disconnect TTL

By default, a connected tab whose bridge sees no `tool.request` for 30
minutes gets automatically parked (WS closed, debugger detached — the
popup goes back to "Not connected"). Since 1.3.0 the setting has **one**
value, changed **only from the console**:

```bash
browser-link config get idle-ttl              # show the value in effect (30 min by default)
browser-link config set idle-ttl 15           # 15 minutes
browser-link config set idle-ttl never        # disable auto-disconnect
```

The server sends that value to every tab when it connects, and
`config set idle-ttl` also pushes it to the tabs already connected (see
below). The popup and the Admin window show the same value read-only, with
the command that changes it.

**A value you chose in the popup before 1.3.0 is no longer used.** The
extension ignores it, whatever its age, and applies the console's value
(30 minutes if you never set one there). While your old choice differs from
the value in effect, the popup shows it with the exact command that keeps
it, for example `browser-link config set idle-ttl 5`; once you run it, or
choose to keep the new value, the note goes away by itself when the two
agree.

(Values outside 1-1440 minutes are clamped to the nearest bound; a
non-numeric value is rejected with an error instead of being applied.)

Lowering the TTL applies against each tab's **absolute** last-activity
time, not the moment you changed the setting — a tab that has already
been idle longer than the new TTL disconnects on the next sweep (within
about a minute).

**A running flow is not idle.** A flow's steps run inside the extension and
never arrive as tool calls, so while a flow runs on a tab, that tab is not
disconnected, whatever the TTL. When the flow ends, however it ends, the idle
window restarts from its last step. The hold is bounded by the flow's own
maximum duration (its time budget, at most 60 s, in the foreground; 30
minutes when detached): past it the window restarts from that bound. A
single call still running, such as a long `wait_for` or `download`, holds
the tab too, so a TTL shorter than the call never parks it in the middle;
its reply restarts the window. A call that never answers stops holding after
10 minutes.

**Applying a change to connected tabs.** `config set idle-ttl` tries to
push the new value to **already-connected** tabs immediately, over the
multi-agent IPC bridge (see above) — this requires a `browser-link`
primary to be running with multi-agent mode on (the default); otherwise
the value is saved and applies the next time a tab connects.

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

Both are changed from the command line (`browser-link config set` and
`browser-link cdp allow`), so an agent that has shell access on your machine
can run them too. They are a consent step for you, not a barrier against an
agent that already has a shell. The protection that holds is on the Chrome
side: the debugging port is open only if you started Chrome with
`--remote-debugging-port`, and the grant is time-boxed and visible in
`browser-link cdp status`. When a tool call reaches a `cdp:` tab without both conditions met, it fails with
one of exactly two errors naming the missing step:

```
cdp-direct is disabled. The user can enable it with: browser-link config set cdp-direct.enabled true
cdp-direct requires an active grant. Ask the user to run: browser-link cdp allow
```

Two residual caveats worth stating plainly, in the same spirit as the
[security model](#security-model)'s "malware already inside Chrome" caveat:

- **No popup, therefore no Stop button — `cdp revoke` is the kill switch.**
  cdp-direct has no extension, so the [Flows panel](#the-flows-panel) and
  its one-click Stop do not exist on this transport. The asymmetry is by
  design, and `browser-link cdp revoke` is the lever that replaces it:
  since v0.26.0 a running `browser.flow` re-checks the grant before every
  step, so revoking mid-flow **stops it within one step** and the flow
  returns cleanly with `stopped_by: "cancelled"` plus everything it
  completed. (Before v0.26.0 an in-flight flow was grandfathered until it
  finished — bounded by the 60-second flow budget, but not stoppable.)
  Every other tool call re-checks the gate fresh, as it always did. Note
  the same one-step caveat as everywhere else: a step already dispatched
  finishes, and a `sleep` or a repeat's `delay_ms` runs to completion (up
  to 30 s) before the next check.
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

# 3. Grant time-boxed access (a CLI command: anyone with a shell on this machine can run it, an agent included).
browser-link cdp allow                    # uses cdp-direct.grant-ttl (default 60 min)
browser-link cdp allow --minutes 15       # a shorter one-off grant
browser-link cdp allow --minutes never    # never expires — reduces the security posture, see above

# 4. Check state at any time.
browser-link cdp status                   # enabled?, port, grant remaining, endpoint reachable?

# 5. Revoke whenever you want the door shut again — this also stops a flow already running.
browser-link cdp revoke
```

Once both conditions hold, `browser.list_tabs` also returns cdp-direct
page targets — real Chrome tabs, filtered to exclude `devtools://` and
`chrome-extension://` pages — with `tab_id` values shaped `cdp:<targetId>`
and `transport: "cdp"`, alongside your normal extension tabs (which keep
working exactly as before, unaffected). Claims, `browser.read` by name,
saved flows by name, the persistent map's origin-keyed hints, the `known`
hint on results, the activity trail's url and title, and every other
cross-cutting feature work on a `cdp:` tab the same as an extension tab.
One thing is missing: a `cdp:` tab carries no `build` or `view_sig` in
`list_tabs`, so its map start pack is chosen by origin and path alone and the
learner records no build or view signature for it. These features look the
tab up through the same cdp-direct discovery as `list_tabs`; if that
discovery fails, the call still answers, without the map hints and with no
page in its trail row.

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

| Supported in v1                                                                                                                                                                                                | NOT supported in v1 (use the extension instead)                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tabs`, `ping`, `snapshot`, `find`, `state`, `screenshot`, `click`, `type`, `press`, `evaluate`, `wait_for`\*, `navigate`, `flow` (incl. `detach`), `flow_status`, `flow_cancel`, `download` (`url` mode) | `console`, `network`, `network_body`, `canvas_screenshot`, `dialog_respond`, `set_permission`, `wait_for_tab`, `drag`, `download` (`selector` mode) |

\* `wait_for`'s `network_url` mode also falls back to "use the extension"
— cdp-direct does not buffer network requests, so there is nothing to poll
against. `selector` and `expression` modes are fully supported.

**Detached execution has full parity here, with one asymmetry.** The
cdp-direct runner is in-process, so `detach` / `flow_status` /
`flow_cancel` behave identically — same one-per-tab rule, same 30-minute
`expired` ceiling, the same manifest under the same 128 KB ceiling (over
it, the same `manifest_truncated: true` rather than a shortened array),
same single `flow-finished` event in `browser.events`. What does not exist
is the popup's Stop button (there is no extension), so a human's only
lever is `browser-link cdp revoke`, which stops a detached flow within one
step exactly as it stops a foreground one and reports
`stopped_by: "grant-revoked"` — a stop an agent must not treat as a
transient failure to retry, since the gate it would retry into is shut.
The MV3 worker-termination story has no equivalent either, and does
not need one: the runner lives in the browser-link process, so if that
process dies the flow dies with it and there is no state left to be wrong
about. The flip side is that detached-flow state here is per-process — a
server restart loses the manifests, where the extension's survive in
`chrome.storage.session` for the browser session.

**The connection clock.** The server keeps one connection per `cdp:` tab it
drives and closes it after 5 minutes without a call; the next call dials it
again. That value is internal, not a setting. A running flow holds its tab's
connection open, bounded by the flow's own maximum duration (its time budget,
at most 60 s, in the foreground; 30 minutes when detached), and when the flow
ends the 5 minutes restart from its last step. A long single call, such as a
`wait_for`, holds nothing.

Claims apply to `cdp:` tab_ids through the same registry extension tabs
use. See the CHANGELOG's v0.23.0 entry for what a future v2 might add
(console/network mirroring, canvas capture, drag).

## Stability

From 1.0.0, versioning follows [semver](https://semver.org): breaking
changes to the stable set below ship only in a major release.

**Stable (changes only in a major):**

- MCP tool names and their input schemas, and the documented result fields.
- CLI commands and their flags.
- `config.json` keys.
- The map database file (`map.db`), with forward-only migrations.

**Internal (may change in any release):**

- The extension-to-server WebSocket protocol. The server and the bundled
  extension are versioned together.
- The in-page observer internals.
- Everything under `packages/plan`.

## Security model

The WebSocket bridge binds to `127.0.0.1:17529` — loopback only, never
on a public interface. Every WebSocket handshake must carry an `Origin`
exactly equal to `chrome-extension://celegobaahdoaigibmjmekhopegfkhpe`, the
browser-link extension's id (the same on every install, pinned by the public
`key` in its manifest), or to `chrome-extension://<id>` for an id you allowed
yourself (below). A missing Origin, a web page, or any other extension is
refused before anything else is checked. The pinned id is a stable id, not
proof of identity: any unpacked extension carrying the same public key gets
it. On top of that, before accepting the handshake the server asks the
operating-system kernel **which process**
opened the incoming TCP connection. The peer check covers two things: the
process must run as **the same OS user** as the server, and its binary
name must be a known Chromium-based browser (Chrome, Chromium, Edge,
Brave, Vivaldi). Otherwise the handshake is refused with HTTP 403 before
any application bytes are exchanged. An owner that cannot be read is
refused too.

- **macOS / Linux** → `lsof -nP -F pcun -iTCP@<host>:<port> -sTCP:ESTABLISHED`;
  the process uid must equal the server's uid
  (`packages/server/src/auth/process-identity.ts`).
- **Windows** → one PowerShell, started for each check, reads the kernel's
  TCP table (`GetExtendedTcpTable`, IPv4 and IPv6, every connection state)
  for the process that owns the peer's end of this connection, then that
  process's user from its token, its image name and its image path
  (`QueryFullProcessImageName`), and the server's own user the same way; the
  two users (SIDs) must be equal. It reads the table again before it lets go
  of the process, so a process that exited and whose id was reused in between
  is never taken for the owner. It declares those Windows calls in memory
  (`System.Reflection.Emit`): nothing is compiled and nothing is written to
  disk. A cold check takes about 0.4 s. When this check cannot run
  (PowerShell missing, those declarations refused by Constrained Language
  Mode or AppLocker, a timeout, a reply it cannot read, a token it
  may not open), the server logs one line naming the step that failed and
  falls back to the earlier check: `netstat -ano` locates the owning PID,
  one PowerShell CIM call (`Win32_Process` + `GetOwner`) reads the image
  name, path and owner of that PID and of the server itself, and
  `tasklist /V` stands in when that call fails or takes over 5 s (the first
  one after boot, while WMI starts, can on a slow machine). A refusal by the
  kernel-table check (another user, two owners) is final: the fallback only
  replaces a check that could not answer.

The handshake is refused in these cases (`evaluateHandshake` in
`packages/server/src/bridge/handshake.ts`, the gate the WebSocket upgrade
and `GET /handshake-check` share; the extension popup shows the reason):

| Status | Reason                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 403    | `Origin not allowed` — the `Origin` header is missing or is not exactly the pinned extension's or an allowed id's; no process lookup runs                                  |
| 403    | `Cannot identify peer` — the socket exposes no remote address or port                                                                                                      |
| 403    | `Peer process unknown` — the lookup found no single owning process; the log line names the cause                                                                           |
| 403    | `Cannot read peer owner` — the OS user of the owning process, or of the server, could not be read                                                                          |
| 403    | `Peer runs as another OS user` — the owning process belongs to a different OS user than the server                                                                         |
| 403    | `Peer is not a Chromium-based browser` — the binary is not on the allowlist                                                                                                |
| 403    | `Peer executable path not allowed` — strict mode only: the executable path is not listed in `peerExecutablePaths`, or could not be read                                    |
| 500    | `Process lookup failed` — the lookup promise rejected. `lookupPeerProcess` itself catches lookup errors and returns no process, which gives the 403 `Peer process unknown` |
| 500    | `Handshake check failed` — the gate itself failed (a bug); the handshake is refused rather than left without an answer                                                     |

The allowlist per OS lives in `packages/server/src/auth/allowlist.ts`.

Concretely this means:

- ✔ Random local processes (curl, other Node scripts, scanners) cannot
  talk to the bridge even if they figured out the port.
- ✔ Another extension, or an old install with another id, cannot open the
  bridge: its Origin carries its own id. The popup says why ("does not
  accept this extension's id").
- ✔ A process that crafts a fake `Origin: chrome-extension://...` header
  is still rejected: the kernel reports its real binary name. The Origin
  check and the peer check are independent; both must pass.
- ✘ Malware that has already injected itself **inside Chrome** (via
  `chrome.debugger` from another extension, dylib injection, gdb attach…)
  passes the check. But that attacker already controls the browser
  directly — the bridge gives them nothing they did not already have.
- ✘ Known gap: a process that runs as **your own OS user** but is confined
  from your files while it can still reach loopback (a Flatpak or Snap app
  with network access and no home access, a macOS App Sandbox app with
  `network.client`, a Windows low-integrity process) passes the same-user
  check, and it passes the name check if its binary carries a browser's
  name. The strict mode below closes this gap by executable path.

No tokens to paste, no manifests to register, no manual step beyond
clicking "Connect this tab" in the extension popup. `browser-link doctor`
lists the current allowlist on your OS, the extension ids allowed to
connect, and whether strict mode is on.

**Allowing another extension id (experts only).** Add
`"allowedExtensionIds"` to `config.json` in the data folder, as an array of
Chrome extension ids (for example `["abcdefghijklmnopabcdefghijklmnop"]`, a
build of your own). Each entry must be exactly 32 letters `a`–`p`; anything
else (a prefix, a wildcard, a full `chrome-extension://` origin) is dropped
with a warning in the [server log](#what-now-stops-a-connection), and the pinned id is always allowed. It is
edited by hand only: no console command, admin panel item, bridge message or
MCP tool writes it.

**Strict mode (experts only).** Add `"peerExecutablePaths"` to
`config.json` in the data folder, as an array of absolute paths to your
browser executables (for example
`["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]`). The peer's
executable path must then equal one of them (case-insensitive on Windows,
exact elsewhere), and a path that cannot be read is refused (on Windows
the `tasklist` fallback reports no path, so with strict mode on, a machine
where PowerShell is blocked refuses every browser). On Windows the path
compared is where the running file is now, as the kernel reports it
(`QueryFullProcessImageName`): every junction and symbolic link resolved.
A listed entry matches that path as written, or as it resolves on disk at
the moment of the check, so an entry through a junction (nvm's
`C:\nvm4w\nodejs\node.exe` is one) keeps matching the program started
through it, and stops matching when the junction points at another file.
The browser's own path is never resolved again, since a junction can be
pointed elsewhere after the program started. Only when the `netstat`
fallback answers is the path the one the program was started with, as CIM
reports it. Absent or
empty means no path check. A list with no valid absolute path refuses
every peer. It is edited by hand only: no console command, admin panel
item, bridge message or MCP tool writes it. Update the list when your
browser moves (a channel switch or a reinstall elsewhere), or it stops
connecting. The socket can belong to a helper process (on macOS, `Google
Chrome Helper`), so list the path the refusal line in the [server log](#what-now-stops-a-connection)
names.

**The Stop button is part of this model, not a convenience.** The human is
the only actor guaranteed to be present while an agent drives your
browser, so they must be able to end it — and `browser.flow` can now run a
bounded `repeat` over hundreds of irreversible actions in a single call.
The popup's [Flows panel](#the-flows-panel) lists every running flow across
every connected tab with a one-click **Stop**, and stopping is real rather
than cosmetic: the bridge owns the loop, so cancelling means the runner
never dispatches the next step. Worst case, one step still lands. Nothing
an agent can do through the MCP tools removes that button — the
registry lives in the extension, on the human's side of the bridge. The one place this guarantee does **not** reach is
[cdp-direct mode](#cdp-direct-mode-no-extension), which has no extension
and therefore no popup; there the equivalent lever is
`browser-link cdp revoke`, which now also stops a flow already in
progress.

**A detached flow is the only thing in browser-link that keeps acting
with no agent attached.** Every other capability here is scoped to a tool
call an agent is waiting on: when the agent's turn ends, nothing is left
running. `browser.flow({ detach: true })` breaks that, deliberately and
narrowly — it is what makes a 900-item drain expressible with trusted
input and a recovery snapshot instead of as a raw `evaluate` loop with
neither. Say it plainly rather than bury it: after such a call, your
browser can be clicking on your behalf while no model is in the loop.

Four bounds hold it in:

- **A human can always stop it.** The popup's Stop button reaches a
  detached flow exactly as it reaches a foreground one, and stopping is
  the same one-step guarantee.
- **It always ends.** A statically computed worst-case budget is still
  mandatory (which is why `repeat.max_iterations` is still required, and
  why an over-ceiling flow is still rejected before anything is
  dispatched), and an absolute 30-minute wall-clock ceiling stops
  anything that outlives it as `expired`.
- **One per tab.** Two loops clicking through the same page have no use
  case and every failure mode.
- **It never resumes itself.** If Chrome kills the service worker
  mid-run, the flow is marked `failed` / `worker-terminated` and stays
  that way. Resuming would double-act on irreversible work.

Nothing about it is on by default: `detach: true` is an explicit
per-call flag, `browser.flow` is individually disable-able, and the tab
had to be connected by hand in the first place.

One deliberate tradeoff to state plainly: since v0.23.9 the extension
**auto-reconnects** after an involuntary drop — when a registered tab's
socket dies uncleanly (the primary MCP server crashed or restarted), it
keeps retrying the connection with capped backoff (1s, 2s, 4s, 8s, 15s,
then every 30s, for up to 10 minutes while the Chrome tab stays open),
over the exact same channel a manual "Connect this tab" click uses, just without waiting for
a fresh human gesture. The server verifies the client's process; the
client never authenticates the server (a legitimately restarted primary
has no shared secret to present — that is what `tab-renamed` continuity
exists for), so during that bounded retry window a local process that
bound `127.0.0.1:17529` before the real server could accept the
reconnect. That attacker needs local code execution and a won loopback
port race — the same preconditions the "malware already inside Chrome"
caveat above and the cdp-direct port-squatting note already accept.
Explicit disconnects and `browser.reset` closes are deliberate goodbyes
and never auto-reconnect, nor does a closed tab; once the 10-minute
window is spent the popup's Connect button is the only way back. The
extension holds the `alarms` permission for this: it wakes the sleeping
service worker between the 30s attempts.

When `browser.list_tabs` finds no tab it still returns the bare `[]` as its first
content block, and adds a second text block `hint: ...` built from the bridge
event log: never connected, connected-then-dropped (how many, which origins,
how long ago), bridge restarted recently, or wiped by `browser.reset` — and
whether to wait for the auto-reconnect or press Connect.

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

For running a second, isolated instance (e.g. the e2e harness), set
`BROWSER_LINK_WS_PORT` (WebSocket bridge, default `17529`) and
`BROWSER_LINK_IPC_PORT` (multi-agent IPC and election, default `17530`) to an
integer from 1024 to 65535; any other value is ignored with one warning on
stderr. The published extension always dials `17529`, so a second instance
only reaches an extension whose bridge URL was changed to match.

The [activity trail](#activity-trail) is a **separate** SQLite file in the
same directory, `activity.db`. Separate on purpose: the map is small and
precious — losing it means relearning every selector — while the trail is
append-only and disposable, thousands of rows a session. Two files means
clearing or vacuuming one never touches the other, and "back up my map" stays
unambiguous. Delete `activity.db` at any time; nothing else depends on it.

**What talks to the network.** The WebSocket bridge listens on loopback
only. The one request the server makes by itself is the update check: a
`GET https://registry.npmjs.org/-/package/<package-name>/dist-tags` with an
`accept: application/json` header and nothing else, so the package name is
the only variable part (`checkUpdates` in
`packages/server/src/commands/updates.ts`). It runs when the terminal UI is
open (`packages/server/src/ui/hooks/use-update-check.ts` checks on mount and
every six hours), when the Admin window asks for its state
(`packages/server/src/admin/primary.ts`), and when you run
`browser-link updates`. The result is cached for six hours in
`update-check.json` in the data directory
(`packages/server/src/commands/update-check.ts`). The MCP server running
alone does not start this check. There is no configuration key or environment
variable that disables it (none found in `packages/server/src/config.ts`),
and a failed check is silent. Other network access happens only when you ask
for it: `browser.download` fetches the URL you give it, and the self-update
in `packages/server/src/commands/self-update.ts` runs `npm install -g`,
which contacts the registry.

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

Requires **Node ≥ 22.22.2** and **pnpm 11+**. The exact pnpm version is
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

### End-to-end cases and the differential gate

Every tool in the server's catalogue (`TOOL_CATALOGUE` in
`packages/server/src/permissions.ts`) has an e2e case in
`packages/e2e/src/run.mjs`, or an exemption with its reason, in
`packages/e2e/src/tool-cases.mjs`. `pnpm run test` fails when a new tool has
neither, or when the table names a case `run.mjs` no longer has: add the case
(or the exemption) in the same PR as the tool. The e2e run itself fails when a
mapped tool was not called under its case name, so a case that is only a
literal in `run.mjs` does not count.

The `e2e-diff` job compares the PR's build with its merge-base's build and
fails on any difference (see [Chrome version](#chrome-version)). The
normalise table masks only the timing keys it lists, and only in tool results;
recorded arguments are compared as sent, so a changed default (`timeout_ms`,
`settle_ms`) is a difference.

A PR whose purpose is to change behavior follows the behavior-change flow:

1. Keep it apart from refactors: one PR for the behavior change alone.
2. Add the `behavior-change` label. The job re-runs when the label is added
   or removed.
3. Name the expected difference in the PR description, on a line that starts
   with `Expected difference:` followed by the tool, the field and the old and
   new values. The job fails a labelled PR without that line, and a labelled
   PR whose title starts with `refactor:` or `refactor(core)`: a refactor never
   carries the label.
4. The job still runs and writes the first difference to the job log and the
   step summary, then passes. Reviewers compare it with the description. A
   harness failure, a setup error, or a self-diff difference (two runs of the
   same build) still fails the job.

Without the label, a difference fails the job.

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
