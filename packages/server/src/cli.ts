#!/usr/bin/env node
import { formatDoctor, runDoctor } from './commands/doctor.js';
import { installAll, installFor } from './commands/install.js';
import { uninstallAll, uninstallFor } from './commands/uninstall.js';
import { printExtensionInstructions } from './commands/extension.js';
import { printAbout } from './commands/about.js';
import { checkUpdates, formatUpdate } from './commands/updates.js';
import { loadConfig } from './config.js';
import { VERSION } from './version.js';
import type { ClientId } from './installers/index.js';

const HELP = `browser-link ${VERSION} — bridge any MCP client to the Chrome tabs you enable.

Usage:
  browser-link                  When invoked from an interactive terminal,
                                opens the setup UI (register a client, show
                                extension steps, run doctor, check updates).
                                When invoked by an MCP client over stdio,
                                starts the MCP server.
  browser-link install          Register browser-link in every detected client.
  browser-link install --client <claude|opencode|copilot>
                                Register only in the named client.
  browser-link uninstall        Remove every registration.
  browser-link uninstall --client <id>
                                Remove only the named registration.
  browser-link extension        Show the Chrome extension assets path and
                                per-OS install instructions.
  browser-link doctor           Diagnose current setup (clients, server, extension, map DB).
  browser-link updates          Check the npm registry for a newer version.
  browser-link about            Show the full explanation of what this is and how it works.
  browser-link version          Print the installed version (also: --version, -v).
  browser-link help             This message.

Environment:
  BROWSER_LINK_DATA_DIR         Override the DB location (defaults per OS).
  BROWSER_LINK_BIN              Override the command stored in client configs
                                (e.g. "node /path/to/dist/index.js" for dev).
  COPILOT_HOME                  Override GitHub Copilot CLI's config dir
                                (default ~/.copilot).`;

function parseClient(argv: string[]): ClientId | null {
  const idx = argv.findIndex((a) => a === '--client');
  if (idx === -1 || idx === argv.length - 1) return null;
  const val = argv[idx + 1];
  if (val === 'claude' || val === 'opencode' || val === 'copilot') return val;
  throw new Error(`Unknown --client value: ${val}. Use claude, opencode or copilot.`);
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
    case 'updates': {
      const info = await checkUpdates();
      console.log(formatUpdate(info));
      // Non-zero exit when we could not reach the registry, so scripts can detect it.
      if (info.error || info.latest === null) process.exit(2);
      return;
    }
    case 'version':
    case '-v':
    case '--version': {
      console.log(VERSION);
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

// No args + both stdin and stdout are TTYs → human in a terminal: mount the
// Ink-based UI (welcome on first run, then the setup menu).
// Otherwise (no TTY anywhere, or output piped) → start the MCP server over stdio.
if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const { startUI } = await import('./ui/start.js');
  await startUI();
  process.exit(0);
}

dispatch(argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
