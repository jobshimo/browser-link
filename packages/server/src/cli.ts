#!/usr/bin/env node
import { formatDoctor, runDoctor } from './commands/doctor.js';
import { installAll, installFor } from './commands/install.js';
import { uninstallAll, uninstallFor } from './commands/uninstall.js';
import { printExtensionInstructions } from './commands/extension.js';
import { printAbout } from './commands/about.js';
import { checkUpdates, formatUpdate } from './commands/updates.js';
import { runToolsCommand } from './commands/tools.js';
import { runMultiAgentCommand } from './commands/multi-agent.js';
import { runFreePort } from './commands/free-port.js';
import { loadConfig } from './config.js';
import { VERSION } from './version.js';
import type { ClientId } from './installers/index.js';
import type { Language } from './commands/welcome.js';

interface CliI18n {
  help: string;
  restartHint: string;
  installNext: string;
  toolsRestart: string;
  unknownCommand: (cmd: string) => string;
  unknownClient: (val: string) => string;
}

function buildHelp(language: Language): string {
  if (language === 'es') {
    return `browser-link ${VERSION} — puente entre cualquier cliente MCP y las pestañas de Chrome que vos habilites.

Uso:
  browser-link                  Abre el setup interactivo (registrar un
                                cliente, ver pasos de la extensión, doctor,
                                buscar actualizaciones) cuando se invoca
                                desde una terminal.
                                Cuando lo invoca un cliente MCP por stdio,
                                arranca el servidor MCP.
  browser-link install          Registra browser-link en todos los clientes detectados.
  browser-link install --client <claude|opencode|copilot>
                                Registra sólo en el cliente nombrado.
  browser-link uninstall        Elimina todos los registros.
  browser-link uninstall --client <id>
                                Elimina sólo el registro nombrado.
  browser-link extension        Muestra la ruta de los assets de la extensión
                                de Chrome y los pasos por SO.
  browser-link doctor           Diagnostica el setup actual (clientes, servidor, extensión, base del mapa).
  browser-link updates          Consulta el registry de npm en busca de versión nueva.
  browser-link tools            Muestra qué tools MCP están habilitadas / deshabilitadas.
  browser-link tools enable <nombre…>   Vuelve a habilitar tools concretas.
  browser-link tools disable <nombre…>  Deshabilita tools concretas.
  browser-link tools preset <id>        Aplica un preset: all | readonly | no-eval | no-map.
  browser-link multi-agent      Estado del modo multi-agente y re-elección automática.
  browser-link multi-agent enable | disable
  browser-link multi-agent auto-reelect enable | disable
  browser-link stop             Mata el proceso browser-link que esté ocupando el
                                puerto 17529 (útil si un cliente MCP quedó zombie).
  browser-link about            Muestra la explicación completa.
  browser-link version          Muestra la versión instalada (también: --version, -v).
  browser-link help             Este mensaje.

Variables de entorno:
  BROWSER_LINK_DATA_DIR         Sobreescribe la ruta de la base (default por SO).
  BROWSER_LINK_BIN              Sobreescribe el comando guardado en los configs
                                de los clientes (p. ej. "node /path/to/dist/index.js" en dev).
  COPILOT_HOME                  Sobreescribe el directorio de config del CLI de
                                GitHub Copilot (default ~/.copilot).`;
  }
  return `browser-link ${VERSION} — bridge any MCP client to the Chrome tabs you enable.

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
  browser-link tools            Show which MCP tools are enabled / disabled.
  browser-link tools enable <name…>   Re-enable specific tools.
  browser-link tools disable <name…>  Disable specific tools.
  browser-link tools preset <id>      Apply a preset: all | readonly | no-eval | no-map.
  browser-link multi-agent      Show multi-agent mode + auto-reelect status.
  browser-link multi-agent enable | disable
  browser-link multi-agent auto-reelect enable | disable
  browser-link stop             Kill the browser-link process holding port 17529
                                (useful when an MCP client left a zombie behind).
  browser-link about            Show the full explanation of what this is and how it works.
  browser-link version          Print the installed version (also: --version, -v).
  browser-link help             This message.

Environment:
  BROWSER_LINK_DATA_DIR         Override the DB location (defaults per OS).
  BROWSER_LINK_BIN              Override the command stored in client configs
                                (e.g. "node /path/to/dist/index.js" for dev).
  COPILOT_HOME                  Override GitHub Copilot CLI's config dir
                                (default ~/.copilot).`;
}

const CLI_I18N: Record<Language, CliI18n> = {
  en: {
    help: '',
    restartHint: 'Restart the MCP client so it picks up the registration.',
    installNext: 'Next: install the Chrome extension — run `browser-link extension`.',
    toolsRestart: 'Restart your MCP client so it picks up the change.',
    unknownCommand: (cmd) => `Unknown command: ${cmd}`,
    unknownClient: (val) => `Unknown --client value: ${val}. Use claude, opencode or copilot.`,
  },
  es: {
    help: '',
    restartHint: 'Reiniciá el cliente MCP para que tome el registro.',
    installNext: 'Siguiente: instalá la extensión de Chrome — corré `browser-link extension`.',
    toolsRestart: 'Reiniciá el cliente MCP para que tome el cambio.',
    unknownCommand: (cmd) => `Comando desconocido: ${cmd}`,
    unknownClient: (val) =>
      `Valor de --client desconocido: ${val}. Usá claude, opencode o copilot.`,
  },
};

function parseClient(argv: string[], language: Language): ClientId | null {
  const idx = argv.findIndex((a) => a === '--client');
  if (idx === -1 || idx === argv.length - 1) return null;
  const val = argv[idx + 1];
  if (val === 'claude' || val === 'opencode' || val === 'copilot') return val;
  throw new Error(CLI_I18N[language].unknownClient(val ?? ''));
}

async function dispatch(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const cfg = loadConfig();
  const language: Language = cfg.language ?? 'en';
  const t = CLI_I18N[language];

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
      console.log(buildHelp(language));
      return;
    }
    case 'install': {
      const client = parseClient(rest, language);
      const reports = client ? [installFor(client)] : installAll();
      for (const r of reports) {
        const prefix = r.installedClient ? '✓' : '·';
        console.log(`${prefix} ${r.displayName}: ${r.message}`);
      }
      console.log('');
      console.log(t.restartHint);
      console.log(t.installNext);
      return;
    }
    case 'uninstall': {
      const client = parseClient(rest, language);
      const reports = client ? [uninstallFor(client)] : uninstallAll();
      for (const r of reports) console.log(`· ${r.displayName}: ${r.message}`);
      return;
    }
    case 'extension': {
      printExtensionInstructions(language);
      return;
    }
    case 'doctor': {
      const report = await runDoctor();
      console.log(formatDoctor(report, language));
      return;
    }
    case 'about': {
      printAbout(language);
      return;
    }
    case 'updates': {
      const info = await checkUpdates();
      console.log(formatUpdate(info, language));
      // Non-zero exit when we could not reach the registry, so scripts can detect it.
      if (info.error || info.latest === null) process.exit(2);
      return;
    }
    case 'tools': {
      console.log(runToolsCommand(rest, language));
      console.log('');
      console.log(t.toolsRestart);
      return;
    }
    case 'multi-agent': {
      console.log(runMultiAgentCommand(rest, language));
      return;
    }
    case 'stop': {
      const result = runFreePort(language);
      console.log(result.message);
      if (!result.ok) process.exit(2);
      return;
    }
    case 'version':
    case '-v':
    case '--version': {
      console.log(VERSION);
      return;
    }
    default: {
      console.error(t.unknownCommand(cmd));
      console.error('');
      console.error(buildHelp(language));
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
