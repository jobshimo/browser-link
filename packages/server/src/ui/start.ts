import { createElement } from 'react';
import { render } from 'ink';
import { loadConfig } from '../config.js';
import { App } from './app.js';

/**
 * Mount the Ink UI and return a promise that resolves when the user quits.
 * cli.ts calls this when stdin/stdout are TTYs (i.e. a human is at the
 * terminal). The MCP-server path never reaches here.
 */
export async function startUI(): Promise<void> {
  const cfg = loadConfig();
  const initialLanguage = cfg.language ?? 'en';
  const skipWelcome = cfg.skipWelcome === true;
  const instance = render(createElement(App, { initialLanguage, skipWelcome }), {
    exitOnCtrlC: true,
  });
  await instance.waitUntilExit();
}
