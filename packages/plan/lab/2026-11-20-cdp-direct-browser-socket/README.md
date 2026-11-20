# Lab 2026-11-20: the browser-level CDP socket (experiment X3)

Experiment X3 of [`docs/design/cdp-direct-parity.md`](../../../../docs/design/cdp-direct-parity.md) (section 6), asked before P7 (the browser-level socket, G11 `wait_for_tab`, G10 `set_permission`). Built from `main` at bf12c1b (release 1.4.39). No product code was changed.

Follows the convention of `2026-11-20-cdp-direct-dialogs/` (X1). The two `chrome-*.txt` files are the verbatim stdout of one run each and are never edited.

| File | What it is |
|---|---|
| `x3-browser-socket.mjs` | The experiment script (`CHROME_PATH=<chrome> node x3-browser-socket.mjs <label>`; stdout is the record). |
| `fixture.html` | `#open-btn` (`window.open` in a click handler), `#blank-link` (`target=_blank`), `#noopener-link` (`target=_blank rel=noopener`), `#noopener-btn` (`window.open(..., 'noopener')`), and `window.openFromScript()` / `openNoopenerFromScript()` for a script-driven open. |
| `chrome-118.txt` | Chrome for Testing 118.0.5993.70 (like the CI e2e job), headless. |
| `chrome-stable.txt` | The local stable Chrome, `Chrome/157.0.8103.51` as it reports itself, headless. |

## Question

(a) Is `Browser.setPermission` available on the browser-level `webSocketDebuggerUrl` of `/json/version` and refused on a page session (exact error)? What do `browserContextId` handling and the default context look like? (b) Do pages opened by `window.open` (from a script, from a click) and by a `target=_blank` link appear in `Target.targetCreated` with `openerId` pointing at the opener, how soon after the cause, and does `/json/list` carry any opener field? (c) Does holding a browser-level socket open change anything for other tabs?

## Method

No MCP server is needed. The script launches a headless Chrome with its own profile and a free remote-debugging port (`launchChrome` of `packages/e2e/src/lib.mjs`, as X1 did) and serves the fixture on a loopback port. Sockets are the server's own `CdpClient` from `packages/server/dist/cdp/client.js`: the browser-level one dials the `webSocketDebuggerUrl` of `/json/version`, the page ones dial `/devtools/page/<id>` and do `Target.getTargetInfo` and `Page.enable` as `transport.ts` `dial` does. Only this script's own Chrome was touched; the owner's browser and primary were not (both files end with `owner primary: pid 54284 still alive`). Everything is headless; no headed part was needed or run.

Part B uses a different permission name for every probe on the same origin (`notifications`, `geolocation`, `midi`, `clipboard-read`, `persistent-storage`, `idle-detection`, `camera`) and reads the state with `navigator.permissions.query` in two tabs on the same origin, one in the default browser context and one in a context made with `Target.createBrowserContext`; an earlier draft of the script reused one name for all probes and could not tell which socket had granted it, so it was rewritten before the runs in these files. Clicks in Part C are `Input.dispatchMouseEvent` on the opener's page socket; script opens use `Runtime.evaluate` with `userGesture: true` (and, once, without it).

## Observations

Every line is quoted from the raw files. Where Chrome 118 and 157 differ it says so.

### 1. `Browser.setPermission` is NOT refused on a page socket (both Chromes)

The design expects a refusal on a page session. There is none, on either Chrome, and the command reaches the same browser-wide permission state:

```
[page-...] Browser.setPermission {"permission":{"name":"notifications"},"setting":"granted","origin":"http://127.0.0.1:..."} (page socket, context omitted) -> {} (1ms)
states (default-tab/second-ctx-tab) after (1): {"notifications":"granted/prompt", ...}
```

`Browser.getVersion` and `Browser.grantPermissions` also work on a page socket. The same call on the browser-level socket answers `{}` identically, so both sockets are usable for `Browser.setPermission`; the browser one is not required to set a permission. Two traps seen on the page socket:

- **`context omitted` always means the default context, even on a page socket of another context.** `setPermission(geolocation)` from the page socket of the tab in the second context changed the default-context tab (`"geolocation":"granted/prompt"`) and left the second-context tab alone.
- **`Browser.grantPermissions` replaces the whole override set: it grants the listed permissions and flips every other permission to denied.** After `Browser.grantPermissions {"permissions":["midi"],...}` on the page socket: `{"notifications":"denied/prompt","geolocation":"denied/prompt","midi":"granted/prompt","clipboard-read":"denied/prompt","persistent-storage":"denied/prompt","idle-detection":"denied/prompt","camera":"denied/prompt"}` (default tab / second-context tab; same on both Chromes).

### 2. `browserContextId` and the default context

- `Browser.setPermission` without `browserContextId` applies to the default context (item 1). With the id of a context made by `Target.createBrowserContext` it applies to that context only: `persistent-storage` became `denied/granted` (default tab / second-context tab).
- An unknown id: `FAILED: Failed to find browser context for id NOSUCHCONTEXT` (both).
- **The default context's own id differs by Chrome.** A tab's `Target.getTargetInfo` carries `browserContextId` in both. On Chrome 118 `Target.getBrowserContexts` returns `{"browserContextIds":[]}` (the default context is not listed) and passing the default tab's own `browserContextId` to `Browser.setPermission` fails: `FAILED: Failed to find browser context for id <that id>`; so on 118 the default context can only be addressed by omitting the id. On Chrome 157 `Target.getBrowserContexts` also returns `"defaultBrowserContextId":"..."` and the call with the default tab's own id succeeds (`-> {}`, and the permission took effect). Omitting the id works on both.
- Other errors, identical on both: unknown permission `FAILED: Invalid PermissionDescriptor name: no-such-permission`; bad setting `FAILED: Unknown permission setting: maybe`. With `origin` omitted the call answers `{}` and changed no tab's state for that origin.

### 3. An override lives only as long as the socket that set it, and closing that socket clears the whole context

This is the finding that changes the design's "Permissions persist in the user's profile" risk. In both files, after closing a socket that had set permissions, every tab on the origin is back to `prompt`, a new tab included:

```
states ... before closing any socket: {..."midi":"granted/prompt","clipboard-read":"granted/prompt","persistent-storage":"denied/granted","idle-detection":"granted/prompt"...}
states ... after closing the second PAGE socket (set idle-detection): {"notifications":"prompt/prompt","geolocation":"prompt/prompt","midi":"prompt/prompt","clipboard-read":"prompt/prompt","persistent-storage":"prompt/granted","idle-detection":"prompt/prompt","camera":"prompt/prompt"}
states ... after closing the BROWSER socket (set clipboard-read, persistent-storage, midi): {... all "prompt/prompt" ...}
a NEW tab on the same origin, new browser socket: clipboard-read=prompt midi=prompt
```

Closing a page socket that had set one permission cleared every override of the default context, including `midi` and `clipboard-read` that the still-open browser socket had set; the second-context `persistent-storage` survived until the browser socket (which had set it) closed. The `(6)` block of the raw files narrows who triggers the clear:

- a page socket that only did `getTargetInfo` + `Page.enable` and closed: `midi=granted` (unchanged);
- a second browser socket that sent `Browser.getVersion` and closed: `midi=granted`;
- a page socket that sent `Browser.getVersion` and closed: `midi=granted`;
- a page socket that SET `geolocation` and closed: `midi=prompt geolocation=prompt` (the `midi` set by another socket is cleared too);
- `Browser.resetPermissions` on the same socket: `midi=prompt`.

So an override is not written to the profile: it is held by the DevTools session that set it, and when that session disconnects the browser context's overrides are reset wholesale, other sessions' included. For P7's G10 this means `set_permission` over cdp-direct is "granted while a socket that set it stays open", is silently undone by any set-then-close of another client (a second page socket of the same tab, Playwright, DevTools), and by this server's own idle sweep or reconnect.

### 4. `openerId` on `Target.targetCreated`: present for every way of opening a page

After `Target.setDiscoverTargets {discover: true}` on the browser socket, with the opener tab's targetId in `openerId`, in both files and for all six cases that opened a page:

| Cause | `canAccessOpener` | `targetCreated` after the trigger started (118 / 157) | `targetInfoChanged` with the url (118 / 157) |
|---|---|---|---|
| `window.open` from a script (`userGesture: true`) | `true` | 4 ms / 6 ms | 16 ms / 18 ms |
| click on a button calling `window.open` | `true` | 6 ms / 7 ms | 19 ms / 19 ms |
| click on a `target=_blank` link (no `rel`) | `false` | 19 ms / 12 ms | 38 ms / 24 ms |
| click on a `target=_blank rel=noopener` link | `false` | 9 ms / 13 ms | 28 ms / 26 ms |
| click on a button calling `window.open(..., 'noopener')` | `false` | 14 ms / 5 ms | 33 ms / 19 ms |
| `window.open(..., 'noopener')` from a script (`userGesture: true`) | `false` | 2 ms / 3 ms | 20 ms / 17 ms |

(The click rows include the three mouse commands before the click lands.) Every `targetCreated` carries `"openerId":"<opener targetId>"` and `"openerFrameId"` (the same value) and `"browserContextId"`, and the script checks `openerId equals opener targetId: true` for all six. Two points that matter for a consumer:

- the first event has `"title":"","url":""`; the url arrives 12 to 19 ms later in `Target.targetInfoChanged`, and `Target.getTargets` shows `openerId` as well, with the url, after the second event. A `tab-created` with `url` must wait for `targetInfoChanged` (or read the URL later) rather than use the `targetCreated` url;
- a `target=_blank` link without `rel=noopener` already has `canAccessOpener: false` (the browser gives such links an implicit noopener), so `canAccessOpener` is not a way to tell a click from a script; `openerId` is present either way.
- `window.open` from a script **without** a user gesture is blocked as a popup: the call returns `null` and no `Target.*` event arrives in 1200 ms (`CASE script-window-open-NO-userGesture`: `trigger returned "null"`, `no Target.* event arrived within 1200ms`). A cdp-direct click or `evaluate` with a gesture opens it; a timer-driven `window.open` does not.
- **`/json/list` has no opener field.** The entry of an opened page has exactly `["description","devtoolsFrontendUrl","id","title","type","url","webSocketDebuggerUrl"]`, the same keys as any tab, in every case and both Chromes. `openerId` exists only on the browser socket (`Target.getTargets` and the target events).

On discovery, existing targets come first as `Target.targetCreated` events (`events from the initial discovery`). On Chrome 157 these include `service_worker`, `browser_ui` and `background_page` targets of the browser's own components and extensions besides pages; the consumer must filter on `type: "page"` (`isDrivablePageTarget` does the same for page sockets).

### 5. Footprint of the browser socket on other tabs: none observed

- `Target.getTargets` reports `attached` per target; it is `true` only for the tabs where this script holds a page socket and does not change when the browser socket opens or discovery is on (`Target.getTargets BEFORE setDiscoverTargets` and `AFTER` list the same values). No `Target.setAutoAttach` was sent and no target was paused or attached by the browser socket.
- `Runtime.evaluate` latency on another tab, 20 samples: all below 2 ms with the browser socket open and discovery on (`[0.5,0.3,0.3,0.6,...]` on 118), the same with it closed (`[0.9,0.3,0.3,0.2,...]`); the existing page socket stayed open after the browser socket closed.
- `Target.setDiscoverTargets {discover: false}` stops the events (no event when a tab is created afterwards).
- A browser socket idle for 6 s with no commands is still open and answers `Target.getTargets` (`still open=true`); this lab did not test a longer idle or a proxy in between.
- Not measured: the effect on the user's own tabs and windows in their real browser (this lab only ever had its own throwaway profile and headless Chrome, so it cannot say anything about a headed window, tab strip or focus); event volume with many tabs; and Chrome's behaviour with 20+ simultaneous sockets.

## What it means for P7

- **G11 (`wait_for_tab`) is feasible as designed**, with a browser socket and `Target.setDiscoverTargets`: `Target.targetCreated` carries `openerId` for `window.open` from a script or a click and for a `target=_blank` link, on 118 and 157, within a few ms of the cause. The design's expectation that `/json/list` has no opener is confirmed, so `opened_from` can only come from the browser socket (a socket that was not already open and discovering when the page opened sees nothing, unless it is subscribed before the click). The `url` comes from the following `targetInfoChanged`. Filter events on `type: "page"` and, for the opener, on `openerId` being a `cdp:` tab this server drives; ignore `service_worker`, `browser_ui` and `background_page`. A script `window.open` with no user gesture opens nothing (not an event the socket can miss).
- **G10 (`set_permission`) does not need the browser socket on these Chromes, but does need a socket that stays open.** `Browser.setPermission` works on the page socket the server already holds (118 and 157). On the page socket `browserContextId` cannot be targeted and the default context is always the one set; with the browser socket a non-default context can be addressed, and the default one only by omitting the id (118) or by id (157). The persistence assumption in the design is wrong for CDP: the override is cleared when the setting socket closes, and any set-then-close by another client clears everything in that context. The semantics question for the owner (G10) is therefore: "the permission holds while this server's connection that set it stays open" (and what happens at an idle sweep or at gate A's close), against `chrome.contentSettings`' persistent setting. The contract test's "restores what it set" is moot: it must instead assert the state after the setting connection closes.
- **`Browser.grantPermissions` is the wrong primitive** (it denies everything not listed); use `Browser.setPermission` per permission.
- **A browser socket has no footprint observed on other tabs** in this lab, so "opened only while needed" is a choice for the owner rather than a requirement from Chrome; the one cost is that the socket's lifetime is the lifetime of any override it set (point 3).
