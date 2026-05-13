import { describe, expect, test } from 'vitest';
import { render } from 'ink-testing-library';
import { Badge, CheckRow, FooterKeys, KeyCap, MenuRow, SectionHead, StatusBar } from './index.js';

/* Render-time smoke tests for the design-system primitives. We assert the
 * visible glyphs + key copy per state — color is covered indirectly via
 * the dim/bold-driven character-level diffs (ink-testing-library renders
 * ANSI to plain text by default, so we don't try to grep for SGR codes). */

describe('KeyCap', () => {
  test('renders the label inside the cap', () => {
    /* ink-testing-library trims trailing whitespace from each line — the
     * KeyCap's right-side space gets stripped from the lastFrame() output
     * but the inverse-block rendering at runtime keeps both. We assert
     * the label is present with the leading space (the left-padding the
     * cap adds). */
    const { lastFrame } = render(<KeyCap label="Enter" />);
    expect(lastFrame() ?? '').toContain(' Enter');
  });
});

describe('Badge', () => {
  test('ok kind renders the success glyph and default label', () => {
    const { lastFrame } = render(<Badge kind="ok" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✓');
    expect(frame).toContain('installed');
  });

  test('warn kind renders the warn glyph and default label', () => {
    const { lastFrame } = render(<Badge kind="warn" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚠');
    expect(frame).toContain('outdated');
  });

  test('off kind renders the dot glyph and the muted label', () => {
    const { lastFrame } = render(<Badge kind="off" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('·');
    expect(frame).toContain('not installed');
  });

  test('label override replaces the default text', () => {
    const { lastFrame } = render(<Badge kind="ok" label="installed (v3)" />);
    expect(lastFrame() ?? '').toContain('installed (v3)');
  });
});

describe('MenuRow', () => {
  test('renders cursor glyph when selected', () => {
    const { lastFrame } = render(<MenuRow selected label="Register" />);
    expect(lastFrame() ?? '').toContain('❯');
  });

  test('renders hotkey marker [h] before the label', () => {
    const { lastFrame } = render(<MenuRow selected hotkey="r" label="Register" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[');
    expect(frame).toContain('r');
    expect(frame).toContain(']');
    expect(frame).toContain('Register');
  });

  test('renders the hint when provided', () => {
    const { lastFrame } = render(
      <MenuRow label="Permissions" hint="which browser.* tools to expose" />,
    );
    expect(lastFrame() ?? '').toContain('which browser.* tools to expose');
  });
});

describe('CheckRow', () => {
  test('on=true renders [x]', () => {
    const { lastFrame } = render(<CheckRow on label="Enable thing" />);
    expect(lastFrame() ?? '').toContain('[x]');
  });

  test('on=false renders [ ]', () => {
    const { lastFrame } = render(<CheckRow on={false} label="Enable thing" />);
    expect(lastFrame() ?? '').toContain('[ ]');
  });

  test('dimmed row still renders the label and the box', () => {
    const { lastFrame } = render(<CheckRow on={false} dimmed label="Auto-reelect" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[ ]');
    expect(frame).toContain('Auto-reelect');
  });
});

describe('SectionHead', () => {
  test('renders the label', () => {
    const { lastFrame } = render(<SectionHead>SETUP</SectionHead>);
    expect(lastFrame() ?? '').toContain('SETUP');
  });

  test('renders the optional hint', () => {
    const { lastFrame } = render(<SectionHead hint="3 / 5 enabled">Browser bridge</SectionHead>);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Browser bridge');
    expect(frame).toContain('3 / 5 enabled');
  });
});

describe('StatusBar', () => {
  test('renders each item with name · state', () => {
    const { lastFrame } = render(
      <StatusBar
        items={[
          { name: 'Claude', state: 'registered', label: 'registered' },
          { name: 'OpenCode', state: 'not registered', label: 'not registered' },
          { name: 'Copilot', state: 'not detected', label: 'not detected' },
        ]}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Claude');
    expect(frame).toContain('OpenCode');
    expect(frame).toContain('Copilot');
    expect(frame).toContain('registered');
    expect(frame).toContain('not registered');
    expect(frame).toContain('not detected');
  });
});

describe('FooterKeys', () => {
  test('renders every key + label with separator dots between', () => {
    const { lastFrame } = render(
      <FooterKeys
        items={[
          { k: '↑↓', label: 'navigate' },
          { k: '↵', label: 'select' },
          { k: 'q', label: 'quit' },
        ]}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑↓');
    expect(frame).toContain('navigate');
    expect(frame).toContain('↵');
    expect(frame).toContain('select');
    expect(frame).toContain('q');
    expect(frame).toContain('quit');
    expect(frame).toContain('·');
  });
});
