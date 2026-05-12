/** Usage protocol pushed to the MCP client on `initialize`. Plain string,
 * intentionally kept short. Edit here when the protocol changes. */
export const SERVER_INSTRUCTIONS = `browser-link bridges Claude Code to the Chrome tabs the user has
explicitly connected through the companion extension, and ships a
persistent UI map backed by a local SQLite DB. The data dir resolves
per-OS via env-paths (\$XDG_DATA_HOME/browser-link on Linux,
~/Library/Application Support/browser-link on macOS, %APPDATA%/browser-link
on Windows). Override with \$BROWSER_LINK_DATA_DIR. The map is private
and per-machine; never persisted in any repo.

## When operating on a tab

1. Before doing anything on a tab whose URL you don't already know,
   call \`browser.map.recall\` with { origin } (and optionally url) to load
   selectors, flows and gotchas previously learned for that app.
2. If recall returns entries with \`failed_at\` more recent than
   \`verified_at\`, treat them as suspect: re-verify (snapshot / evaluate)
   before reusing, or replace them.
3. After every interaction that used a map entry, call
   \`browser.map.record_use\` with { entry_id, ok }. ok=true updates
   verified_at; ok=false updates failed_at. Keep the map honest.
4. After a non-trivial flow that worked end-to-end, persist it with
   \`browser.map.save\`. Three \`kind\` values:
   - selector: { selector, evidence? } — a CSS selector tied to a purpose.
   - flow: { steps: [...] } — an ordered list of actions to reach an outcome.
   - gotcha: { body } — free-form note about something non-obvious.
   Use \`url_pattern\` = pathname (exact). Promote to glob only if you have
   evidence of a parametric route. Provide \`purpose\` as a stable, reusable
   label ("open task detail dialog", not "open IB0311 detail").
5. Never save selectors or flows you have not just successfully executed.
6. Never store domain data (IDs, user names, dates, etc.). The map captures
   UI structure only.

## Identifying the app

- \`origin\` = scheme://host:port of the tab.
- \`app_key\` distinguishes apps that share an origin over time. On first
  save you may omit it; it will be derived from the page title (slugified).
  Use \`browser.map.rename_app\` if that initial guess is poor.

## When something is wrong

- A selector from recall fails → record_use({ok:false}), learn the new
  one, save it (upsert on purpose).
- A whole app got refactored → \`browser.map.forget\` the app_id and let
  the map repopulate as you learn the new structure.
- A tool call fails with "Tab not connected: tab_X" → call
  \`browser.events\` to see whether the bridge changed primary (the
  Chrome tab probably got a new tab_id after a reconnect). Look for a
  \`tab-renamed\` event with previous=tab_X and resume on the current id.

The map is a cache of navigation, not a substitute for \`browser.snapshot\`.
The live snapshot is always the source of truth.`;
