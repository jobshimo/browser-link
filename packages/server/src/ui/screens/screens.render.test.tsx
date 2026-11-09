import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WelcomeScreen } from './welcome.js';
import { MainMenu } from './menu.js';
import { ClientPicker } from './client-picker.js';
import { InstallResultView } from './install-result.js';
import { ExtensionView } from './extension.js';
import { AboutView } from './about.js';
import { LanguageView } from './language.js';
import { AgentInstructionsView } from './agent-instructions.js';
import { PermissionsView } from './permissions.js';
import { MultiAgentView } from './multi-agent.js';
import { NoticeScreen } from './notice.js';
import { App } from '../app.js';
import { loadConfig, saveConfig } from '../../config.js';
import { NOTICE } from '../../notice.js';
import { I18N_ABOUT } from '../../commands/about.js';

/*
 * Render-time crash guard for every Ink screen component. This file ONLY
 * asserts that each screen renders its first frame without throwing — it
 * catches broken imports, missing props, bad JSX, and similar regressions.
 *
 * For real keyboard interaction tests (cursor movement, callbacks fired on
 * key press, state transitions), see the per-screen interaction files:
 *   - agent-instructions.interaction.test.tsx
 *   - menu.interaction.test.tsx
 *   - permissions.interaction.test.tsx
 */

let fakeHome: string;
let originalEnvHome: string | undefined;
let originalUserprofile: string | undefined;
let originalBrowserLinkDataDir: string | undefined;
let originalCopilotHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-render-'));
  originalEnvHome = process.env.HOME;
  originalUserprofile = process.env.USERPROFILE;
  originalBrowserLinkDataDir = process.env.BROWSER_LINK_DATA_DIR;
  originalCopilotHome = process.env.COPILOT_HOME;
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
  // Keep the map DB out of the host machine for the permissions screen.
  process.env.BROWSER_LINK_DATA_DIR = fakeHome;
  delete process.env.COPILOT_HOME;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  if (originalEnvHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnvHome;
  if (originalUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserprofile;
  if (originalBrowserLinkDataDir === undefined) delete process.env.BROWSER_LINK_DATA_DIR;
  else process.env.BROWSER_LINK_DATA_DIR = originalBrowserLinkDataDir;
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalCopilotHome;
  vi.restoreAllMocks();
});

const noop = (): void => undefined;

describe('WelcomeScreen render', () => {
  test('renders the EN title', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        language="en"
        hideDismiss={false}
        onAccept={noop}
        onDismiss={noop}
        onSwapLang={noop}
        onQuit={noop}
      />,
    );
    expect(lastFrame()).toMatch(/browser-link/i);
  });

  test('renders the ES title', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        language="es"
        hideDismiss={false}
        onAccept={noop}
        onDismiss={noop}
        onSwapLang={noop}
        onQuit={noop}
      />,
    );
    expect(lastFrame()).toMatch(/browser-link/i);
  });
});

describe('MainMenu render', () => {
  test('renders every menu entry in EN', () => {
    const { lastFrame } = render(
      <MainMenu language="en" onSelect={noop} onSwapLang={noop} onQuit={noop} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Register browser-link');
    expect(frame).toContain('Agent instructions');
    expect(frame).toContain('Permissions');
    expect(frame).toContain('Multi-agent');
    expect(frame).toContain('Quit');
  });
});

describe('ClientPicker render', () => {
  test('renders the picker title with the available clients', () => {
    const { lastFrame } = render(<ClientPicker language="en" onPick={noop} onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Register browser-link in/i);
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('OpenCode');
  });
});

describe('InstallResultView render', () => {
  test('renders the success branch', () => {
    const { lastFrame } = render(
      <InstallResultView
        language="en"
        report={{
          client: 'claude',
          displayName: 'Claude Code',
          installedClient: true,
          message: 'Done.',
        }}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Claude Code');
    expect(frame).toMatch(/Registered/i);
  });

  test('renders the failure branch', () => {
    const { lastFrame } = render(
      <InstallResultView
        language="en"
        report={{
          client: 'claude',
          displayName: 'Claude Code',
          installedClient: false,
          message: 'Not found.',
        }}
        onBack={noop}
      />,
    );
    expect(lastFrame() ?? '').toMatch(/Not registered/i);
  });
});

describe('ExtensionView render', () => {
  test('renders without crashing', () => {
    const { lastFrame } = render(<ExtensionView language="en" onBack={noop} />);
    expect(lastFrame() ?? '').toMatch(/Chrome extension/i);
  });
});

describe('AboutView render', () => {
  test('renders the About page with the new Author section', () => {
    const { lastFrame } = render(<AboutView language="en" onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/about/i);
    expect(frame).toContain('Martín Miguel Bernal');
  });

  for (const language of ['en', 'es'] as const) {
    test(`${language}: the product notice is the first section, all 3 paragraphs`, () => {
      const { lastFrame } = render(<AboutView language={language} onBack={noop} />);
      // Ink wraps long lines, so compare with whitespace collapsed.
      const flat = (lastFrame() ?? '').replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
      const noticeAt = flat.indexOf(NOTICE[language].title);
      expect(noticeAt).toBeGreaterThanOrEqual(0);
      expect(noticeAt).toBeLessThan(flat.indexOf(I18N_ABOUT[language].whatTitle));
      for (const p of NOTICE[language].paragraphs) {
        expect(flat).toContain(p.slice(0, 40).replace(/\s+/g, ' '));
      }
    });
  }
});

describe('LanguageView render', () => {
  test('renders both language choices', () => {
    const { lastFrame } = render(<LanguageView language="en" onPick={noop} onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('English');
    expect(frame).toContain('Español');
  });
});

describe('AgentInstructionsView render', () => {
  test('renders every supported client with a status badge', () => {
    const { lastFrame } = render(<AgentInstructionsView language="en" onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('OpenCode');
    expect(frame).toContain('GitHub Copilot CLI');
    expect(frame).toMatch(/no file yet/i);
  });
});

describe('PermissionsView render', () => {
  test('renders the catalogue + presets', () => {
    const { lastFrame } = render(<PermissionsView language="en" onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Permissions/i);
    expect(frame).toMatch(/Browser bridge/i);
    expect(frame).toMatch(/Persistent UI map/i);
  });
});

describe('MultiAgentView render', () => {
  test('renders the multi-agent toggles', () => {
    const { lastFrame } = render(<MultiAgentView language="en" onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Multi-agent/i);
    expect(frame).toMatch(/Auto-reelect/i);
  });
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('NoticeScreen', () => {
  for (const [language, label] of [
    ['en', 'I understand'],
    ['es', 'Entendido'],
  ] as const) {
    test(`${language}: renders the title, the 3 paragraphs and "${label}"`, () => {
      const { lastFrame } = render(<NoticeScreen language={language} onAcknowledge={noop} />);
      const frame = lastFrame() ?? '';
      // Ink wraps long lines, so compare with whitespace collapsed.
      const flat = frame.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
      expect(flat).toContain(NOTICE[language].title);
      for (const p of NOTICE[language].paragraphs) {
        expect(flat).toContain(p.slice(0, 40).replace(/\s+/g, ' '));
      }
      expect(frame).toContain(label);
    });
  }

  test('Enter fires onAcknowledge; other keys do not', async () => {
    let calls = 0;
    const { stdin } = render(
      <NoticeScreen
        language="en"
        onAcknowledge={() => {
          calls += 1;
        }}
      />,
    );
    await tick();
    stdin.write('q');
    stdin.write('d');
    stdin.write(' ');
    await tick();
    expect(calls).toBe(0);
    stdin.write('\r');
    await tick();
    expect(calls).toBe(1);
  });
});

describe('App first-run notice gate', () => {
  const WELCOME = 'I understand, continue';
  const MENU = 'browser-link — setup';

  test('not acknowledged: the notice comes first, Enter persists and continues to welcome', async () => {
    const { lastFrame, stdin } = render(
      <App initialLanguage="en" skipWelcome={false} noticeAcknowledged={false} />,
    );
    await tick();
    expect(lastFrame()).toContain(NOTICE.en.title);
    expect(lastFrame()).not.toContain(WELCOME);
    stdin.write('\r');
    await tick();
    expect(loadConfig().noticeAcknowledged).toBe(true);
    expect(lastFrame()).toContain(WELCOME);
  });

  test('not acknowledged with skipWelcome: the notice still comes first, then the menu', async () => {
    saveConfig({ skipWelcome: true });
    const { lastFrame, stdin } = render(
      <App initialLanguage="es" skipWelcome={true} noticeAcknowledged={false} />,
    );
    await tick();
    expect(lastFrame()).toContain(NOTICE.es.title);
    stdin.write('\r');
    await tick();
    expect(loadConfig().noticeAcknowledged).toBe(true);
    expect(loadConfig().skipWelcome).toBe(true);
    expect(lastFrame()).toContain('browser-link — configuración');
  });

  test('acknowledged: welcome is the first screen when not skipped', async () => {
    const { lastFrame } = render(
      <App initialLanguage="en" skipWelcome={false} noticeAcknowledged={true} />,
    );
    await tick();
    expect(lastFrame()).not.toContain(NOTICE.en.title);
    expect(lastFrame()).toContain(WELCOME);
  });

  test('acknowledged: skipWelcome still lands on the menu', async () => {
    const { lastFrame } = render(
      <App initialLanguage="en" skipWelcome={true} noticeAcknowledged={true} />,
    );
    await tick();
    expect(lastFrame()).not.toContain(NOTICE.en.title);
    expect(lastFrame()).toContain(MENU);
  });
});
