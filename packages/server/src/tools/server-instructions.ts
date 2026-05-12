/** Usage protocol pushed to the MCP client on `initialize`. Plain string,
 * intentionally kept short. Edit here when the protocol changes. */
export const SERVER_INSTRUCTIONS = `browser-link bridges Claude Code to the Chrome tabs the user has
explicitly connected through the companion extension, and ships a
persistent UI map backed by a local SQLite DB. The data dir resolves
per-OS via env-paths ($XDG_DATA_HOME/browser-link on Linux,
~/Library/Application Support/browser-link on macOS, %APPDATA%/browser-link
on Windows). Override with $BROWSER_LINK_DATA_DIR. The map is private
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

## Sharing tabs with other agents

This primary may be serving several MCP clients at once (multi-agent mode).
To stop two agents fighting over the same Chrome tab there is a cooperative
claim layer:

- \`browser.list_tabs\` includes \`claimed_by\` (null if free, otherwise the
  agent that holds the claim) and \`claimed_by_me\` (boolean). Use it before
  starting work on a tab whose state you don't already own.
- \`browser.my_tabs\` returns YOUR active claims with timestamps. If the
  user asks which tab you are using, this is the answer.
- Action tools (\`browser.click\`, \`browser.type\`, \`browser.navigate\`,
  \`browser.evaluate\`) auto-claim a free tab on first use and refresh
  activity on subsequent calls. If another agent holds the tab, they
  return an error naming the owner — do NOT retry blindly; ask the user
  whose tab it should be, or use a different tab.
- Read tools (\`browser.snapshot\`, \`browser.console\`, \`browser.network\`,
  \`browser.network_body\`, \`browser.events\`, \`browser.ping\`) ignore claims.
- \`browser.claim_tab({ tab_id, ttl_minutes?, label? })\` reserves a tab
  explicitly. Provide a stable \`label\` (eg "claude-code", "opencode") so
  other agents and the user see WHO holds the tab. The label is display
  only — security relies on the IPC session id (kernel-vetted), not on
  what an agent calls itself.
- \`browser.release_tab({ tab_id })\` hands a tab back. Claims also auto-
  release when an agent disconnects or after the inactivity TTL elapses
  (default 10 minutes), so explicit release is only needed for early
  hand-off.

When you get a claim-conflict error: do NOT spin-retry. Either work on a
different tab from \`list_tabs\`, or surface the conflict to the user and
let them decide.

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
