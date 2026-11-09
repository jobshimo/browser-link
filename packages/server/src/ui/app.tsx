import { useApp } from 'ink';
import { useState } from 'react';
import {
  AboutView,
  AgentInstructionsView,
  ClientPicker,
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
import { saveConfig } from '../config.js';
import { installFor, type InstallReport } from '../commands/install.js';
import { statusAll } from '../commands/instructions.js';
import { openUrl } from '../utils/open-url.js';
import { INSTALLERS, type ClientId } from '../installers/index.js';
import type { AdminInput } from '../admin/descriptor.js';

const REPO_URL = 'https://github.com/jobshimo/browser-link';

type Screen =
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
}

/* True when at least one of the supported MCP clients is detected on
 * disk. When false, the register flow short-circuits to the
 * EmptyClientsView instead of rendering a picker the user can't act on.
 *
 * `detect()` does a file existence check — cheap enough to run on every
 * navigation to the picker, and accurate after a manual install. */
function anyClientDetected(): boolean {
  return INSTALLERS.some((i) => i.detect().installed);
}

export function App({ initialLanguage, skipWelcome, noticeAcknowledged, statusInput }: AppProps) {
  const { exit } = useApp();
  const [language, setLanguage] = useState<Language>(initialLanguage);
  // The screen the console opens on once the notice is out of the way:
  // the welcome on first run, the status view after it.
  const firstRunScreen: Screen = skipWelcome
    ? { kind: 'status' }
    : { kind: 'welcome', hideDismiss: false };
  const [screen, setScreen] = useState<Screen>(
    noticeAcknowledged ? firstRunScreen : { kind: 'notice' },
  );

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
    } else if (action === 'permissions') setScreen({ kind: 'permissions' });
    else if (action === 'multiAgent') setScreen({ kind: 'multi-agent' });
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
    case 'notice':
      return (
        <NoticeScreen
          language={language}
          onAcknowledge={() => {
            saveConfig({ noticeAcknowledged: true });
            setScreen(firstRunScreen);
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
            saveConfig({ skipWelcome: true, language });
            toStatus();
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
            const report = installFor(id);
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
      return <PermissionsView language={language} onBack={backToMenu} />;

    case 'multi-agent':
      return <MultiAgentView language={language} onBack={backToMenu} />;

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
            setLanguage(next);
            saveConfig({ language: next });
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
