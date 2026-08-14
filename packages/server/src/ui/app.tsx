import { useApp, useInput } from 'ink';
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
  PermissionsView,
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

const REPO_URL = 'https://github.com/jobshimo/browser-link';

type Screen =
  | { kind: 'welcome'; hideDismiss: boolean }
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

export function App({ initialLanguage, skipWelcome }: AppProps) {
  const { exit } = useApp();
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [screen, setScreen] = useState<Screen>(
    skipWelcome ? { kind: 'menu' } : { kind: 'welcome', hideDismiss: false },
  );

  // Global Ctrl+C kill. Ink already handles SIGINT but we explicitly exit so
  // any in-flight cleanup runs through the React lifecycle.
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') exit();
  });

  const swapLang = () => {
    setLanguage((l) => (l === 'en' ? 'es' : 'en'));
  };
  const backToMenu = () => {
    setScreen({ kind: 'menu' });
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

  switch (screen.kind) {
    case 'welcome':
      return (
        <WelcomeScreen
          language={language}
          hideDismiss={screen.hideDismiss}
          onAccept={() => {
            backToMenu();
          }}
          onDismiss={() => {
            saveConfig({ skipWelcome: true, language });
            backToMenu();
          }}
          onSwapLang={swapLang}
          onQuit={exit}
        />
      );

    case 'menu':
      return (
        <MainMenu
          language={language}
          onSelect={(action: MenuAction) => {
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
          }}
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
