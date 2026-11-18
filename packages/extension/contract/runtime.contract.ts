// What every `Runtime` guarantees (design 3.1; slice 21): `manifestVersion`
// is the manifest's version, `pageUrl` names a page of the extension, and a
// message an extension page sends reaches `onMessage`. It runs against the
// in-memory fake under vitest (`src/app/extension-contracts.test.ts`) and
// against the real `chrome.runtime` adapter inside the service worker
// (`entry.ts`, run by the e2e; R6). The contract's listener answers nothing
// and returns false, so the product's own listener still answers the page.

import { type ContractCase, equal } from '@browser-link/core';
import type { Runtime } from '../src/app/popup-router.js';

/** The page the message case opens: it sends `versionCheck` on load. */
export const CONTRACT_SENDER_PAGE = 'popup.html';

export interface RuntimeHarness {
  runtime: Runtime;
  /** The manifest's version, read without the subject. */
  version: string;
  /** Open an extension page at `url` in the background; answers its closer. */
  openPage(url: string): Promise<() => Promise<void>>;
  /** Let time pass until `done` resolves; reject when it has not after `timeoutMs`. */
  until(done: Promise<void>, timeoutMs: number): Promise<void>;
}

/** How long the contract waits for the page's message. */
export const CONTRACT_MESSAGE_TIMEOUT_MS = 15_000;

const actionOf = (message: unknown): unknown =>
  typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>).action
    : undefined;

export function defineRuntimeContract(make: () => RuntimeHarness): ContractCase[] {
  return [
    {
      name: "manifestVersion is the manifest's version, and pageUrl names a page of the extension",
      run: async () => {
        const { runtime, version } = make();
        equal(runtime.manifestVersion(), version, 'manifestVersion');
        const url = new URL(runtime.pageUrl(CONTRACT_SENDER_PAGE));
        equal(url.pathname, `/${CONTRACT_SENDER_PAGE}`, 'pageUrl path');
        equal(
          url.protocol === 'http:' || url.protocol === 'https:',
          false,
          'pageUrl is not a web URL',
        );
        await Promise.resolve();
      },
    },
    {
      name: 'a message an extension page sends reaches onMessage',
      run: async () => {
        const { runtime, openPage, until } = make();
        let received = (): void => undefined;
        const done = new Promise<void>((resolve) => {
          received = resolve;
        });
        runtime.onMessage((message) => {
          if (actionOf(message) === 'versionCheck') received();
          return false;
        });
        const closePage = await openPage(runtime.pageUrl(CONTRACT_SENDER_PAGE));
        try {
          await until(done, CONTRACT_MESSAGE_TIMEOUT_MS);
        } finally {
          await closePage();
        }
      },
    },
  ];
}
