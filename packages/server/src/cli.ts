#!/usr/bin/env node
import { formatDoctor, runDoctor } from './commands/doctor.js';
import { installAll, installFor } from './commands/install.js';
import { uninstallAll, uninstallFor } from './commands/uninstall.js';
import { printExtensionInstructions } from './commands/extension.js';
import { printAbout } from './commands/about.js';
import { loadConfig } from './config.js';
import type { ClientId } from './installers/index.js';

const HELP = `browser-link — bridge Claude Code to the Chrome tabs you enable.

Usage:
  browser-link                  When invoked from an interactive terminal,
                                opens a setup menu (register Claude Code,
                                show extension steps, run doctor, about).
                                When invoked by Claude Code (no TTY),
                                starts the MCP server over stdio.
  browser-link install          Register browser-link with Claude Code.
  browser-link uninstall        Remove the registration.
  browser-link extension        Show the path of the Chrome extension assets
                                and per-OS install instructions.
  browser-link doctor           Diagnose current setup (Claude Code, server, extension, map DB).
  browser-link about            Show the full explanation of what this is and how it works.
  browser-link help             This message.

Environment:
  BROWSER_LINK_DATA_DIR         Override the DB location (defaults per OS).
  BROWSER_LINK_BIN              Override the command stored in client configs
                                (e.g. "node /path/to/dist/index.js" for dev).`;

function parseClient(argv: string[]): ClientId | null {
  const idx = argv.findIndex((a) => a === '--client');
  if (idx === -1 || idx === argv.length - 1) return null;
  const val = argv[idx + 1];
  if (val === 'claude' || val === 'opencode') return val;
  throw new Error(`Unknown --client value: ${val}. Use claude or opencode.`);
}

async function dispatch(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case 'start': {
      const { runServer } = await import('./server.js');
      await runServer();
      return;
    }
    case 'help':
    case '-h':
    case '--help': {
      console.log(HELP);
      return;
    }
    case 'install': {
      const client = parseClient(rest);
      const reports = client ? [installFor(client)] : installAll();
      for (const r of reports) {
        const prefix = r.installedClient ? '✓' : '·';
        console.log(`${prefix} ${r.displayName}: ${r.message}`);
      }
      console.log('');
      console.log('Restart the MCP client so it picks up the registration.');
      console.log('Next: install the Chrome extension — run `browser-link extension`.');
      return;
    }
    case 'uninstall': {
      const client = parseClient(rest);
      const reports = client ? [uninstallFor(client)] : uninstallAll();
      for (const r of reports) console.log(`· ${r.displayName}: ${r.message}`);
      return;
    }
    case 'extension': {
      printExtensionInstructions();
      return;
    }
    case 'doctor': {
      const report = await runDoctor();
      console.log(formatDoctor(report));
      return;
    }
    case 'about': {
      const cfg = loadConfig();
      printAbout(cfg.language ?? 'en');
      return;
    }
    default: {
      console.error(`Unknown command: ${cmd}`);
      console.error('');
      console.error(HELP);
      process.exit(2);
    }
  }
}

const argv = process.argv.slice(2);

// No args + both stdin and stdout are TTYs → human in a terminal: show the
// welcome / disclaimer screen (unless previously dismissed) and then the
// setup menu in the chosen language.
// Otherwise (no TTY anywhere, or output piped) → start the MCP server over stdio.
if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const cfg = loadConfig();
  const { runMenu } = await import('./commands/menu.js');
  let language = cfg.language ?? 'en';
  if (!cfg.skipWelcome) {
    const { runWelcome } = await import('./commands/welcome.js');
    const welcome = await runWelcome({ initial: language });
    if (welcome.action === 'quit') process.exit(0);
    language = welcome.language;
  }
  await runMenu(language);
  process.exit(0);
}

dispatch(argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
