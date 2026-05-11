# @jobshimo/browser-link

MCP server that bridges an AI assistant (Claude Code, OpenCode, …) to a Chrome
tab through a small WebSocket relay and a companion Chrome extension. Comes
with a persistent UI map so the assistant remembers selectors, flows and
gotchas it learned about each app, across sessions.

## Install

```bash
npm install -g @jobshimo/browser-link
```

This puts the `browser-link` binary on your PATH on macOS, Linux and Windows.

## Set it up

```bash
browser-link install        # register browser-link in every detected MCP client
browser-link extension      # show the path of the Chrome extension assets and OS-specific install steps
browser-link doctor         # diagnose current setup
```

After `install`, restart your MCP client. After `extension`, follow the
printed steps to load the unpacked extension in Chrome and click "Conectar"
on any tab.

## Tools exposed

Browser bridge: `browser.list_tabs`, `browser.ping`, `browser.navigate`,
`browser.snapshot`, `browser.click`, `browser.type`, `browser.evaluate`,
`browser.console`, `browser.network`, `browser.network_body`.

UI map (persistent across sessions): `browser.map.recall`,
`browser.map.save`, `browser.map.record_use`, `browser.map.forget`,
`browser.map.rename_app`, `browser.map.apps`.

The server also ships usage instructions for the assistant via the MCP
`initialize` handshake — no manual prompt setup required.

## Where the data lives

```
macOS    ~/Library/Application Support/browser-link/map.db
Linux    $XDG_DATA_HOME/browser-link/map.db   (default: ~/.local/share/browser-link/map.db)
Windows  %APPDATA%/browser-link/map.db
```

Override with `BROWSER_LINK_DATA_DIR`. The database is local to your
machine and never uploaded anywhere.

## License

MIT — see [LICENSE](https://github.com/jobshimo/browser-link/blob/main/LICENSE).
