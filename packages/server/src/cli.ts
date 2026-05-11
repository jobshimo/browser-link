#!/usr/bin/env node
import { formatDoctor, runDoctor } from './commands/doctor.js';
import { installAll, installFor } from './commands/install.js';
import { uninstallAll, uninstallFor } from './commands/uninstall.js';
import { printExtensionInstructions } from './commands/extension.js';
import type { ClientId } from './installers/index.js';

const HELP = `browser-link — bridge an MCP client (Claude Code, OpenCode) to a Chrome tab.

Usage:
  browser-link                  Start the MCP server (used by clients via stdio).
  browser-link install [--client claude|opencode]
                                Register browser-link with the MCP client(s).
                                With no flag, installs into every detected client.
  browser-link uninstall [--client claude|opencode]
                                Remove the registration. Without --client, all.
  browser-link extension        Show the path of the Chrome extension assets
                                and per-OS install instructions.
  browser-link doctor           Diagnose current setup (clients, server, extension, map DB).
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
    default: {
      console.error(`Unknown command: ${cmd}`);
      console.error('');
      console.error(HELP);
      process.exit(2);
    }
  }
}

const argv = process.argv.slice(2);

// No args + stdin is a pipe (the MCP client launched us) → start server.
// No args + interactive TTY → show help so the human knows what to do.
if (argv.length === 0 && process.stdin.isTTY) {
  console.log(HELP);
  process.exit(0);
}

dispatch(argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
