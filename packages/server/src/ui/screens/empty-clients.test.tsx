import { describe, expect, test } from 'vitest';
import { render } from 'ink-testing-library';
import { EmptyClientsView } from './empty-clients.js';

/* Render test for the EmptyClients state — asserts the headline copy,
 * the supported clients list, and the footer hotkeys are present. */
const noop = (): void => undefined;

describe('EmptyClientsView render', () => {
  test('renders the headline and the supported clients list (EN)', () => {
    const { lastFrame } = render(
      <EmptyClientsView language="en" onRescan={noop} onOpenRepo={noop} onBack={noop} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No MCP clients detected');
    expect(frame).toContain('Supported clients');
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('OpenCode');
    expect(frame).toContain('GitHub Copilot CLI');
    expect(frame).toContain('rescan');
  });

  test('renders the headline in Spanish (ES)', () => {
    const { lastFrame } = render(
      <EmptyClientsView language="es" onRescan={noop} onOpenRepo={noop} onBack={noop} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No se detectó');
    expect(frame).toContain('Clientes soportados');
  });

  test("'r' fires onRescan", async () => {
    let rescanCalls = 0;
    const onRescan = () => {
      rescanCalls += 1;
    };
    const { stdin } = render(
      <EmptyClientsView language="en" onRescan={onRescan} onOpenRepo={noop} onBack={noop} />,
    );
    await new Promise((resolve) => setImmediate(resolve));
    stdin.write('r');
    await new Promise((resolve) => setImmediate(resolve));
    expect(rescanCalls).toBe(1);
  });
});
