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

/*
 * Smoke tests for every Ink screen component. Goal: catch render-time crashes
 * (broken imports, missing props, bad JSX) and lift the coverage of src/ui/**
 * off zero. These tests do NOT exercise user interaction — interaction belongs
 * in per-screen test files when behavior is non-trivial; here we only assert
 * that the first frame renders with the screen's title.
 */

let fakeHome: string;
let originalEnvHome: string | undefined;
let originalUserprofile: string | undefined;
let originalBrowserLinkDataDir: string | undefined;
let originalCopilotHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-smoke-'));
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

describe('WelcomeScreen smoke', () => {
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

describe('MainMenu smoke', () => {
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

describe('ClientPicker smoke', () => {
  test('renders the picker title with the available clients', () => {
    const { lastFrame } = render(<ClientPicker language="en" onPick={noop} onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Register browser-link in/i);
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('OpenCode');
  });
});

describe('InstallResultView smoke', () => {
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

describe('ExtensionView smoke', () => {
  test('renders without crashing', () => {
    const { lastFrame } = render(<ExtensionView language="en" onBack={noop} />);
    expect(lastFrame() ?? '').toMatch(/Chrome extension/i);
  });
});

describe('AboutView smoke', () => {
  test('renders the About page with the new Author section', () => {
    const { lastFrame } = render(<AboutView language="en" onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/about/i);
    expect(frame).toContain('Martín Miguel Bernal');
  });
});

describe('LanguageView smoke', () => {
  test('renders both language choices', () => {
    const { lastFrame } = render(<LanguageView language="en" onPick={noop} onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('English');
    expect(frame).toContain('Español');
  });
});

describe('AgentInstructionsView smoke', () => {
  test('renders every supported client with a status badge', () => {
    const { lastFrame } = render(<AgentInstructionsView language="en" onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('OpenCode');
    expect(frame).toContain('GitHub Copilot CLI');
    expect(frame).toMatch(/no file yet/i);
  });
});

describe('PermissionsView smoke', () => {
  test('renders the catalogue + presets', () => {
    const { lastFrame } = render(<PermissionsView language="en" onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Permissions/i);
    expect(frame).toMatch(/Browser bridge/i);
    expect(frame).toMatch(/Persistent UI map/i);
  });
});

describe('MultiAgentView smoke', () => {
  test('renders the multi-agent toggles', () => {
    const { lastFrame } = render(<MultiAgentView language="en" onBack={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Multi-agent/i);
    expect(frame).toMatch(/Auto-reelect/i);
  });
});
