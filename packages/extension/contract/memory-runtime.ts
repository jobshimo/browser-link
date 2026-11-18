// An in-memory `Runtime` (the contract's fake, and the router tests'): a
// fixed version, pages under `chrome-extension://<id>/`, and `send`, which
// delivers a message to every `onMessage` listener as an extension page
// would and answers with the first reply.

import type { MessageReply, Runtime } from '../src/app/popup-router.js';

export interface MemoryRuntime extends Runtime {
  /** Deliver `message` as an extension page would; resolves with the first
   * reply, or `undefined` when every listener returned false unanswered. */
  send(message: unknown): Promise<unknown>;
}

export function createMemoryRuntime(version: string, id = 'memory'): MemoryRuntime {
  const listeners: ((message: unknown, reply: MessageReply) => boolean)[] = [];
  return {
    manifestVersion: () => version,
    pageUrl: (path) => `chrome-extension://${id}/${path}`,
    onMessage(listener) {
      listeners.push(listener);
    },
    send(message) {
      return new Promise((resolve) => {
        let open = false;
        for (const listener of listeners) {
          if (listener(message, resolve)) open = true;
        }
        if (!open) resolve(undefined);
      });
    },
  };
}
