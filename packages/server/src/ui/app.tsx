import { useApp } from 'ink';
import { useState } from 'react';
import {
  AboutView,
  AgentInstructionsView,
  ClientPicker,
  ConfigUnreadableView,
  DoctorView,
  EmptyClientsView,
  ExtensionView,
  FreePortView,
  InstallResultView,
  LanguageView,
  MainMenu,
  MultiAgentView,
  NoticeScreen,
  PermissionsView,
  StatusView,
  UpdatesView,
  WelcomeScreen,
  type MenuAction,
} from './screens/index.js';
import type { Language } from '../commands/welcome.js';
import {
  ConfigUnreadableError,
  readConfig,
  saveConfig,
  type BrowserLinkConfig,
  type RestoreDefaultsResult,
  type UnreadableConfig,
} from '../config.js';
import { installFor, type InstallReport } from '../commands/install.js';
import { statusAll } from '../commands/instructions.js';
import { openUrl } from '../utils/open-url.js';
import { INSTALLERS, getInstaller, type ClientId } from '../installers/index.js';
import { safeDetect } from './components.js';
import type { AdminInput } from '../admin/descriptor.js';

const REPO_URL = 'https://github.com/jobshimo/browser-link';

type Screen =
  | { kind: 'config-unreadable'; problem: UnreadableConfig }
  | { kind: 'notice' }
  | { kind: 'welcome'; hideDismiss: boolean }
  | { kind: 'status' }
  | { kind: 'menu' }
  | { kind: 'pick-client' }
  | { kind: 'empty-clients' }
  | { kind: 'install-result'; report: InstallReport }
  | { kind: 'permissions' }
  | { kind: 'multi-agent' }
  | { kind: 'extension' }
  | { kind: 'doctor' }
  | { kind: 'updates' }
  | { kind: 'free-port' }
  | { kind: 'language' }
  | { kind: 'about' }
  | { kind: 'agent-instructions'; initialCursorClient?: ClientId };

interface AppProps {
  initialLanguage: Language;
  skipWelcome: boolean;
  /** False until the user confirmed the product notice; the notice is then
   * the first screen, whatever `skipWelcome` says. */
  noticeAcknowledged: boolean;
  /** Test seam for the status view's facts; production reads the machine. */
  statusInput?: () => Promise<AdminInput>;
  /** Set when config.json could not be read at start: the console opens on
   * the unreadable-config screen instead of the notice. */
  configProblem?: UnreadableConfig;
  /** Test seam for that screen's restore; production restores on disk. */
  restoreConfig?: () => RestoreDefaultsResult;
}

/* True when at least one of the supported MCP clients is detected on
 * disk. When false, the register flow short-circuits to the
 * EmptyClientsView instead of rendering a picker the user can't act on.
 *
 * `detect()` does a file existence check — cheap enough to run on every
 * navigation to the picker, and accurate after a manual install. A config
 * that exists but cannot be parsed counts as detected, so the picker shows
 * that client marked as unreadable instead of the empty state. */
function anyClientDetected(): boolean {
  return INSTALLERS.some((i) => {
    const detected = safeDetect(i);
    return !detected.ok || detected.result.installed;
  });
}

/* Register one client. The installers throw on a config they cannot parse;
 * the result screen shows that message instead of the console crashing. */
function registerClient(id: ClientId): InstallReport {
  try {
    return installFor(id);
  } catch (err) {
    return {
      client: id,
      displayName: getInstaller(id).displayName,
      installedClient: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/* The screen a config opens on: the notice until it is acknowledged, then
 * the welcome on first run, the status view after it. */
function openingScreen(cfg: Pick<BrowserLinkConfig, 'skipWelcome' | 'noticeAcknowledged'>): Screen {
  if (cfg.noticeAcknowledged !== true) return { kind: 'notice' };
  return cfg.skipWelcome === true ? { kind: 'status' } : { kind: 'welcome', hideDismiss: false };
}

export function App({
  initialLanguage,
  skipWelcome,
  noticeAcknowledged,
  statusInput,
  configProblem,
  restoreConfig,
}: AppProps) {
  const { exit } = useApp();
  const [language, setLanguage] = useState<Language>(initialLanguage);
  // The screen the console opens on once the notice is out of the way:
  // the welcome on first run, the status view after it.
  const firstRunScreen = openingScreen({ skipWelcome, noticeAcknowledged: true });
  const [screen, setScreen] = useState<Screen>(
    configProblem
      ? { kind: 'config-unreadable', problem: configProblem }
      : openingScreen({ skipWelcome, noticeAcknowledged }),
  );

  /* Every console write goes through here: while config.json is unreadable
   * nothing is written and the unreadable-config screen is shown instead.
   * Returns whether the write happened. */
  const showConfigProblem = (problem: UnreadableConfig): void => {
    setScreen({ kind: 'config-unreadable', problem: { path: problem.path, error: problem.error } });
  };
  const save = (patch: Partial<BrowserLinkConfig>): boolean => {
    try {
      saveConfig(patch);
      return true;
    } catch (error) {
      if (!(error instanceof ConfigUnreadableError)) throw error;
      showConfigProblem(error);
      return false;
    }
  };
  /* The screens that read config.json when they open: an unreadable file
   * shows its screen instead of the defaults. */
  const openConfigScreen = (next: Screen): void => {
    const read = readConfig();
    if (read.state === 'unreadable') showConfigProblem(read);
    else setScreen(next);
  };
  /* After the unreadable-config screen: wherever the file now says. */
  const continueAfterConfig = (): void => {
    const read = readConfig();
    if (read.state === 'unreadable') showConfigProblem(read);
    else setScreen(openingScreen(read.config));
  };

  // Ctrl+C exits through Ink itself: start.ts renders with exitOnCtrlC, which
  // consumes the keystroke before any useInput handler could see it.

  const swapLang = () => {
    setLanguage((l) => (l === 'en' ? 'es' : 'en'));
  };
  const backToMenu = () => {
    setScreen({ kind: 'menu' });
  };
  const toStatus = () => {
    setScreen({ kind: 'status' });
  };

  /* When the user picks Register from the menu, we route to either the
   * full picker or the empty state depending on whether any client is
   * actually present. The detection runs at navigation time so a user
   * that installs Claude in another terminal and comes back doesn't get
   * stuck on the empty screen forever. */
  const enterPickClient = (): void => {
    if (anyClientDetected()) setScreen({ kind: 'pick-client' });
    else setScreen({ kind: 'empty-clients' });
  };

  /* One routing for the menu rows, shared by the menu and the status view
   * (which shows the same rows below the server state). */
  const selectMenuAction = (action: MenuAction): void => {
    if (action === 'register') enterPickClient();
    else if (action === 'instructions') {
      // If at least one client is outdated, auto-focus the first one
      // so the next Enter refreshes it. The lookup is cheap (three
      // file stats); doing it here keeps the navigation contract
      // out of the menu screen and away from the installer module.
      const firstOutdated = statusAll().find((r) => r.state.kind === 'installed-outdated');
      setScreen({
        kind: 'agent-instructions',
        initialCursorClient: firstOutdated?.client,
      });
    } else if (action === 'permissions') openConfigScreen({ kind: 'permissions' });
    else if (action === 'multiAgent') openConfigScreen({ kind: 'multi-agent' });
    else if (action === 'extension') setScreen({ kind: 'extension' });
    else if (action === 'doctor') setScreen({ kind: 'doctor' });
    else if (action === 'updates') setScreen({ kind: 'updates' });
    else if (action === 'freePort') setScreen({ kind: 'free-port' });
    else if (action === 'language') setScreen({ kind: 'language' });
    else if (action === 'about') setScreen({ kind: 'about' });
    else if (action === 'welcome') setScreen({ kind: 'welcome', hideDismiss: true });
    else if (action === 'repo') openUrl(REPO_URL);
    // 'quit' is handled by onQuit instead.
  };

  switch (screen.kind) {
    case 'config-unreadable':
      return (
        <ConfigUnreadableView
          language={language}
          problem={screen.problem}
          onContinue={continueAfterConfig}
          onQuit={exit}
          onSwapLang={swapLang}
          {...(restoreConfig ? { restore: restoreConfig } : {})}
        />
      );

    case 'notice':
      return (
        <NoticeScreen
          language={language}
          onAcknowledge={() => {
            if (save({ noticeAcknowledged: true })) setScreen(firstRunScreen);
          }}
        />
      );

    case 'welcome':
      return (
        <WelcomeScreen
          language={language}
          hideDismiss={screen.hideDismiss}
          onAccept={() => {
            // Re-opened from the menu (`w`): back where it came from.
            if (screen.hideDismiss) backToMenu();
            else toStatus();
          }}
          onDismiss={() => {
            if (save({ skipWelcome: true, language })) toStatus();
          }}
          onSwapLang={swapLang}
          onQuit={exit}
        />
      );

    case 'status':
      return (
        <StatusView
          language={language}
          onSelect={selectMenuAction}
          onOpenMenu={backToMenu}
          onSwapLang={swapLang}
          onQuit={exit}
          {...(statusInput ? { loadInput: statusInput } : {})}
        />
      );

    case 'menu':
      return (
        <MainMenu
          language={language}
          onSelect={selectMenuAction}
          onSwapLang={swapLang}
          onQuit={exit}
        />
      );

    case 'pick-client':
      return (
        <ClientPicker
          language={language}
          onPick={(id: ClientId) => {
            const report = registerClient(id);
            setScreen({ kind: 'install-result', report });
          }}
          onBack={backToMenu}
        />
      );

    case 'empty-clients':
      return (
        <EmptyClientsView
          language={language}
          onRescan={enterPickClient}
          onOpenRepo={() => {
            openUrl(REPO_URL);
          }}
          onBack={backToMenu}
        />
      );

    case 'install-result':
      return <InstallResultView language={language} report={screen.report} onBack={backToMenu} />;

    case 'permissions':
      return (
        <PermissionsView
          language={language}
          onBack={backToMenu}
          onConfigUnreadable={showConfigProblem}
        />
      );

    case 'multi-agent':
      return (
        <MultiAgentView
          language={language}
          onBack={backToMenu}
          onConfigUnreadable={showConfigProblem}
        />
      );

    case 'extension':
      return <ExtensionView language={language} onBack={backToMenu} />;

    case 'doctor':
      return <DoctorView language={language} onBack={backToMenu} />;

    case 'updates':
      return <UpdatesView language={language} onBack={backToMenu} />;

    case 'free-port':
      return <FreePortView language={language} onBack={backToMenu} />;

    case 'language':
      return (
        <LanguageView
          language={language}
          onPick={(next) => {
            if (save({ language: next })) setLanguage(next);
          }}
          onBack={backToMenu}
        />
      );

    case 'about':
      return <AboutView language={language} onBack={backToMenu} />;

    case 'agent-instructions':
      return (
        <AgentInstructionsView
          language={language}
          onBack={backToMenu}
          initialCursorClient={screen.initialCursorClient}
        />
      );
  }
}
