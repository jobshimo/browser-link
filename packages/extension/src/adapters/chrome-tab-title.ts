/** The title Chrome shows for a tab (`chrome.tabs.get`); rejects as
 * `chrome.tabs.get` does for a closed tab. Its caller is `app/flow-control.ts`. */
export function chromeTabTitle(tabId: number): Promise<string | undefined> {
  return chrome.tabs.get(tabId).then((tab) => tab.title);
}
