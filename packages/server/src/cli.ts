#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';
import type { InstructionsReport } from './commands/instructions.js';
import type { ClientId } from './installers/index.js';
import type { Language } from './commands/welcome.js';

// Only the real entry point enables Node's on-disk compile cache, before any
// command module loads, so later runs reuse the compiled code. Importing this
// module (tests) must not change the importing process.
const isEntryPoint = isMainModule();
if (isEntryPoint && typeof enableCompileCache === 'function') enableCompileCache();

// Command modules are imported lazily inside each `dispatch` case: a run
// loads only the module its command needs, so `version` or `help` never pay
// for better-sqlite3, the MCP SDK or the IPC client.

// True when Node was started with this file as its entry script, through any
// symlink or shim (`node_modules/.bin`) and with or without the `.js`
// extension (`node dist/cli`). The native realpath canonicalises the case of
// Windows paths, so `node c:\...\cli.js` still matches.
function isMainModule(): boolean {
  const entry = process.argv.at(1);
  if (entry === undefined) return false;
  const self = canonicalPath(fileURLToPath(import.meta.url));
  if (self === null) return false;
  return [entry, `${entry}.js`].some((candidate) => canonicalPath(candidate) === self);
}

function canonicalPath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

interface CliI18n {
  help: string;
  restartHint: string;
  installNext: string;
  toolsRestart: string;
  unknownCommand: (cmd: string) => string;
  unknownClient: (val: string) => string;
  unknownInstructionsAction: (val: string) => string;
  instructionsInstallNext: string;
  instructionsUninstallDone: string;
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
  browser-link config get       Muestra todas las configuraciones conocidas (idle-ttl, flow-recording, map-learning…).
  browser-link config get idle-ttl
                                Muestra el TTL de auto-desconexión por inactividad configurado.
  browser-link config set idle-ttl <minutos|never>
                                Configura el TTL de auto-desconexión (1-1440 min, o "never" para
                                desactivarlo). El mismo valor es editable desde el popup de la
                                extensión — gana la última escritura (ver README). Bajar el TTL
                                cuenta desde la última actividad de cada pestaña: una pestaña ya
                                inactiva puede desconectarse en el próximo barrido.
  browser-link config get flow-recording
                                Muestra si la grabación de flows por demostración está habilitada.
  browser-link config set flow-recording <on|off>
                                Habilita/deshabilita la grabación de flows (opt-in, apagado por
                                defecto). El mismo valor es editable desde el popup de la
                                extensión — gana la última escritura (ver README).
  browser-link config set map-learning <on|off>
                                Habilita/deshabilita el aprendizaje automático del mapa (encendido
                                por defecto): el servidor cuenta qué selectores funcionaron o
                                fallaron por app, solo el selector, nunca valores (ver README).
  browser-link config set downloads.dir <ruta-absoluta|default>
                                Directorio donde browser.download guarda los archivos (por
                                defecto <directorio de datos>/downloads). Los agentes pueden
                                nombrar el archivo, nunca elegir el directorio.
  browser-link config get cdp-direct.enabled | cdp-direct.port | cdp-direct.grant-ttl
                                Muestra la configuración de cdp-direct (ver "browser-link cdp"
                                más abajo).
  browser-link config set cdp-direct.enabled <true|false>
                                Habilita/deshabilita el modo cdp-direct (apagado por defecto).
                                Habilitarlo NO alcanza para que un agente use una pestaña cdp: —
                                además hace falta un permiso vigente (browser-link cdp allow).
  browser-link config set cdp-direct.port <puerto>
                                Puerto loopback para cdp-direct (default 9222). El host es
                                siempre 127.0.0.1, nunca configurable.
  browser-link config set cdp-direct.grant-ttl <minutos|never>
                                Duración por defecto de un permiso otorgado con
                                "browser-link cdp allow" cuando no se pasa --minutes (default
                                60, 1-1440, o "never" — reduce la postura de seguridad).
  browser-link cdp allow [--minutes N]
                                Otorga un permiso de tiempo limitado para que los agentes usen
                                cdp-direct (ver la sección "cdp-direct mode" del README). Solo
                                vos podés correr esto — ningún agente puede otorgárselo a sí
                                mismo.
  browser-link cdp revoke      Revoca el permiso de cdp-direct vigente.
  browser-link cdp status      Muestra si cdp-direct está habilitado, el puerto configurado,
                                el estado del permiso (ninguno/vigente/expirado, tiempo
                                restante) y si hay un endpoint de Chrome DevTools alcanzable
                                ahora mismo en ese puerto.
  browser-link map              Lista las apps que el mapa persistente de UI conoce
                                (app_key, origin, cantidad de entradas/flows, última vez).
  browser-link map show <app>   Muestra las entradas y flows guardados de una app
                                (identificada por app_key u origin).
  browser-link map forget <app> [--flow <nombre>]
                                Elimina un flow puntual por nombre, o (con --yes) toda
                                una app y sus datos. Sin --yes solo muestra qué se
                                borraría y el comando exacto para confirmar. --flow
                                también pide --yes cuando <app> coincide con más de un
                                origin.
  browser-link map export [<app>] [--out <archivo.json>]
                                Exporta el mapa (o una sola app) como JSON a stdout, o
                                a --out. El archivo puede contener estructura de UI y
                                pasos de flows guardados — revisalo antes de compartirlo.
  browser-link map import <archivo.json> [--replace]
                                Importa una exportación del mapa. Por defecto hace un
                                merge (upsert de apps/flows, agrega entradas nuevas,
                                omite duplicados exactos); --replace primero borra los
                                datos existentes de cada app importada. Todo el archivo
                                se valida antes de escribir (pasos de flows, campos de
                                entradas, versión de exportación, límites de tamaño) —
                                cualquier elemento inválido aborta la importación sin
                                escribir nada.
  browser-link activity         Últimas acciones que los agentes ejecutaron en el
                                navegador, más recientes primero. Filtros: --tab,
                                --agent, --tool, --flow, --failed, --limit.
  browser-link activity report [--since 7d|<fecha ISO>] [--agent <id de sesión>]
                                Informe de fricción: errores, señales (timeouts,
                                esperas sin coincidencia, clics desviados…),
                                objetivos que más fallan y un resumen por sesión.
  browser-link activity export [--out <archivo>] [--format json|ndjson|csv] [--redact]
                                Vuelca el rastro a un fichero para archivarlo o
                                pasárselo a otro agente. --redact quita los payloads,
                                los títulos y las query strings de las URLs.
  browser-link activity clear [--older-than 7d] [--yes]
                                Borra el rastro. Sin --older-than exige --yes.
  browser-link instructions     Muestra si el bloque de instrucciones de browser-link
                                está presente en el .md global de cada cliente
                                (Claude, OpenCode, Copilot CLI).
  browser-link instructions install
  browser-link instructions install --client <claude|opencode|copilot>
                                Inserta o refresca el bloque en el .md global.
  browser-link instructions uninstall
  browser-link instructions uninstall --client <id>
                                Quita el bloque, deja el resto del archivo intacto.
  browser-link stop             Mata el proceso browser-link que esté ocupando el
                                puerto 17529 (útil si un cliente MCP quedó zombie)
                                y todos los demás servidores browser-link vivos,
                                una línea por proceso.
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
  browser-link config get       Show every known config setting (idle-ttl, flow-recording, map-learning…).
  browser-link config get idle-ttl
                                Show the configured idle-disconnect TTL.
  browser-link config set idle-ttl <minutes|never>
                                Set the idle-disconnect TTL (1-1440 min, or "never" to disable
                                it). The same setting is editable from the extension's popup —
                                last write wins (see README). Lowering the TTL counts from each
                                tab's last activity: an already-idle tab may disconnect on the
                                next sweep.
  browser-link config get flow-recording
                                Show whether flow recording by demonstration is enabled.
  browser-link config set flow-recording <on|off>
                                Enable/disable flow recording (opt-in, off by default). The same
                                setting is editable from the extension's popup — last write wins
                                (see README).
  browser-link config set map-learning <on|off>
                                Enable/disable automatic map learning (on by default): the server
                                counts which selectors worked or failed per app, the selector only,
                                never values (see README).
  browser-link config set downloads.dir <absolute-path|default>
                                Directory browser.download writes files into (default
                                <data dir>/downloads). Agents can name a file, never pick the
                                directory.
  browser-link config get cdp-direct.enabled | cdp-direct.port | cdp-direct.grant-ttl
                                Show cdp-direct's configuration (see "browser-link cdp" below).
  browser-link config set cdp-direct.enabled <true|false>
                                Enable/disable cdp-direct mode (off by default). Enabling it
                                alone does NOT let an agent use a cdp: tab — a live grant is
                                also required (browser-link cdp allow).
  browser-link config set cdp-direct.port <port>
                                Loopback port cdp-direct dials (default 9222). The host is
                                always 127.0.0.1, never configurable.
  browser-link config set cdp-direct.grant-ttl <minutes|never>
                                Default lifetime of a grant recorded by "browser-link cdp allow"
                                when --minutes is not passed (default 60, 1-1440, or "never" —
                                reduces the security posture).
  browser-link cdp allow [--minutes N]
                                Record a time-boxed grant letting agents use cdp-direct (see the
                                README's "cdp-direct mode" section). Only you can run this — no
                                agent can grant itself access.
  browser-link cdp revoke      Revoke the current cdp-direct grant.
  browser-link cdp status      Show whether cdp-direct is enabled, the configured port, the
                                grant state (none/active/expired, remaining time), and whether a
                                Chrome DevTools endpoint is reachable right now on that port.
  browser-link map              List apps known to the persistent UI map (app_key,
                                origin, entry/flow counts, last seen).
  browser-link map show <app>   Show the saved entries and flows for one app
                                (looked up by app_key or origin).
  browser-link map forget <app> [--flow <name>]
                                Delete one named flow, or (with --yes) a whole app and
                                its data. Without --yes, only prints what would be
                                deleted and the exact command to confirm. --flow also
                                asks for --yes when <app> matches more than one origin.
  browser-link map export [<app>] [--out <file.json>]
                                Export the map (or one app) as JSON, to stdout or to
                                --out. The file may contain UI structure and flow steps
                                that were saved — review it before sharing.
  browser-link map import <file.json> [--replace]
                                Import a map export. Default is a merge (upsert apps/
                                flows, append new entries, skip exact duplicates);
                                --replace deletes each imported app's existing data
                                first. The whole file is validated up front (flow
                                steps, entry fields, export version, sanity caps) —
                                any invalid item aborts the import without writing.
  browser-link activity         Recent actions agents ran in the browser, newest
                                first. Filters: --tab, --agent, --tool, --flow,
                                --failed, --limit.
  browser-link activity report [--since 7d|<ISO date>] [--agent <session id>]
                                Friction report: errors, flags (timeouts, unmatched
                                waits, retargeted clicks…), the most failing targets
                                and a per-session summary.
  browser-link activity export [--out <file>] [--format json|ndjson|csv] [--redact]
                                Dump the trail to a file to archive it or hand it to
                                another agent. --redact strips payloads, titles and
                                URL query strings.
  browser-link activity clear [--older-than 7d] [--yes]
                                Delete the trail. Without --older-than, --yes is
                                required.
  browser-link instructions     Show whether the browser-link instructions block
                                is present in each client's global .md file
                                (Claude, OpenCode, Copilot CLI).
  browser-link instructions install
  browser-link instructions install --client <claude|opencode|copilot>
                                Insert or refresh the block in the global .md file.
  browser-link instructions uninstall
  browser-link instructions uninstall --client <id>
                                Remove the block, leaving the rest of the file
                                intact.
  browser-link stop             Kill the browser-link process holding port 17529
                                (useful when an MCP client left a zombie behind)
                                and every other live browser-link server, one
                                line per process.
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
    unknownInstructionsAction: (val) =>
      `Unknown instructions action: ${val}. Use install, uninstall or no arg for status.`,
    instructionsInstallNext:
      'Restart your MCP client so it picks up the new instructions on its next session.',
    instructionsUninstallDone: 'Block removed. The rest of each file was left untouched.',
  },
  es: {
    help: '',
    restartHint: 'Reiniciá el cliente MCP para que tome el registro.',
    installNext: 'Siguiente: instalá la extensión de Chrome — corré `browser-link extension`.',
    toolsRestart: 'Reiniciá el cliente MCP para que tome el cambio.',
    unknownCommand: (cmd) => `Comando desconocido: ${cmd}`,
    unknownClient: (val) =>
      `Valor de --client desconocido: ${val}. Usá claude, opencode o copilot.`,
    unknownInstructionsAction: (val) =>
      `Acción de instructions desconocida: ${val}. Usá install, uninstall, o ningún argumento para status.`,
    instructionsInstallNext:
      'Reiniciá tu cliente MCP para que tome las nuevas instrucciones en la próxima sesión.',
    instructionsUninstallDone: 'Bloque eliminado. El resto del archivo quedó intacto.',
  },
};

function printInstructionsReports(reports: InstructionsReport[]): void {
  for (const r of reports) {
    const prefix = r.message ? '·' : ' ';
    const msg = r.message ?? r.filePath;
    console.log(`${prefix} ${r.displayName}: ${msg}`);
  }
}

function parseClient(argv: string[], language: Language): ClientId | null {
  const idx = argv.findIndex((a) => a === '--client');
  if (idx === -1 || idx === argv.length - 1) return null;
  const val = argv[idx + 1];
  if (val === 'claude' || val === 'opencode' || val === 'copilot') return val;
  throw new Error(CLI_I18N[language].unknownClient(val));
}

export async function dispatch(argv: string[]): Promise<void> {
  // `argv.at(0)` returns `string | undefined`, which is what we want
  // here — at runtime the array really can be empty (bare invocation
  // of the CLI). Destructuring `const [cmd] = argv` would have typed
  // `cmd` as `string` (the tsconfig leaves `noUncheckedIndexedAccess`
  // off) and forced an eslint-disable on the `case undefined` branch.
  const cmd = argv.at(0);
  const rest = argv.slice(1);

  // The version is language-independent: print it before the config is read.
  if (cmd === 'version' || cmd === '-v' || cmd === '--version') {
    console.log(VERSION);
    return;
  }

  // Every other command reads the config first, as it always has (help and
  // the unknown-command error are localised; a corrupt config warns once).
  const { loadConfig } = await import('./config.js');
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
      const { installAll, installFor } = await import('./commands/install.js');
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
      const { uninstallAll, uninstallFor } = await import('./commands/uninstall.js');
      const reports = client ? [uninstallFor(client)] : uninstallAll();
      for (const r of reports) console.log(`· ${r.displayName}: ${r.message}`);
      return;
    }
    case 'extension': {
      const { printExtensionInstructions } = await import('./commands/extension.js');
      printExtensionInstructions(language);
      return;
    }
    case 'doctor': {
      const { formatDoctor, runDoctor } = await import('./commands/doctor.js');
      const report = await runDoctor();
      console.log(formatDoctor(report, language));
      return;
    }
    case 'about': {
      const { printAbout } = await import('./commands/about.js');
      printAbout(language);
      return;
    }
    case 'updates': {
      const { checkUpdates, formatUpdate } = await import('./commands/updates.js');
      const info = await checkUpdates();
      console.log(formatUpdate(info, language));
      // Non-zero exit when we could not reach the registry, so scripts can detect it.
      if (info.error || info.latest === null) process.exit(2);
      return;
    }
    case 'tools': {
      const { runToolsCommand } = await import('./commands/tools.js');
      console.log(runToolsCommand(rest, language));
      console.log('');
      console.log(t.toolsRestart);
      return;
    }
    case 'multi-agent': {
      const { runMultiAgentCommand } = await import('./commands/multi-agent.js');
      console.log(runMultiAgentCommand(rest, language));
      return;
    }
    case 'config': {
      const { runConfigCommand } = await import('./commands/config.js');
      console.log(await runConfigCommand(rest, language));
      return;
    }
    case 'cdp': {
      const { runCdpCommand } = await import('./commands/cdp.js');
      console.log(await runCdpCommand(rest, language));
      return;
    }
    case 'map': {
      const { runMapCommand } = await import('./commands/map.js');
      console.log(runMapCommand(rest, language));
      return;
    }
    case 'activity': {
      const { runActivityCommand } = await import('./commands/activity.js');
      console.log(runActivityCommand(rest, language));
      return;
    }
    case 'instructions': {
      // `rest.at(0)` correctly types the missing-arg case as `undefined`
      // (vs. `rest[0]: string` under the project's loose index access).
      const action = rest.at(0);
      const instructions = await import('./commands/instructions.js');
      if (action === undefined || action === 'status') {
        const client = parseClient(rest, language);
        const reports = client ? [instructions.statusFor(client)] : instructions.statusAll();
        console.log(instructions.formatStatus(reports, language));
        return;
      }
      if (action === 'install') {
        const client = parseClient(rest, language);
        const reports = client
          ? [instructions.installInstructionsFor(client)]
          : instructions.installInstructionsAll();
        printInstructionsReports(reports);
        console.log('');
        console.log(t.instructionsInstallNext);
        return;
      }
      if (action === 'uninstall') {
        const client = parseClient(rest, language);
        const reports = client
          ? [instructions.uninstallInstructionsFor(client)]
          : instructions.uninstallInstructionsAll();
        printInstructionsReports(reports);
        console.log('');
        console.log(t.instructionsUninstallDone);
        return;
      }
      console.error(t.unknownInstructionsAction(action));
      process.exit(2);
      return;
    }
    case 'stop': {
      const { runFreePort } = await import('./commands/free-port.js');
      const result = runFreePort(language);
      console.log(result.message);
      if (!result.ok) process.exit(2);
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

if (isEntryPoint) {
  const argv = process.argv.slice(2);

  // No args + both stdin and stdout are TTYs → human in a terminal: mount the
  // Ink-based UI (welcome on first run, then the setup menu).
  // Otherwise (no TTY anywhere, or output piped) → start the MCP server over stdio.
  if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    const { startUI } = await import('./ui/start.js');
    await startUI();
    process.exit(0);
  }

  dispatch(argv).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
