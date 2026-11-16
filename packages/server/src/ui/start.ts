import { createElement } from 'react';
import { render } from 'ink';
import { DEFAULT_LANGUAGE, readConfig } from '../config.js';
import { App } from './app.js';

/**
 * Mount the Ink UI and return a promise that resolves when the user quits.
 * cli.ts calls this when stdin/stdout are TTYs (i.e. a human is at the
 * terminal). The MCP-server path never reaches here.
 *
 * An unreadable config.json opens the console on its own screen (restore
 * the defaults or quit); its language cannot be read, so the screen starts
 * in English and `l` swaps it.
 */
export async function startUI(): Promise<void> {
  const read = readConfig();
  const props =
    read.state === 'unreadable'
      ? {
          initialLanguage: DEFAULT_LANGUAGE,
          skipWelcome: false,
          noticeAcknowledged: false,
          configProblem: { path: read.path, error: read.error },
        }
      : {
          initialLanguage: read.config.language ?? DEFAULT_LANGUAGE,
          skipWelcome: read.config.skipWelcome === true,
          noticeAcknowledged: read.config.noticeAcknowledged === true,
        };
  const instance = render(createElement(App, props), {
    exitOnCtrlC: true,
  });
  await instance.waitUntilExit();
}
