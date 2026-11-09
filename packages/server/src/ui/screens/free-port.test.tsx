import { describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';

/* The Free port screen shows every process `stop` handled (S2). runFreePort
 * is mocked: this test never looks up or kills a real process. */
vi.mock('../../commands/free-port.js', () => ({
  runFreePort: vi.fn(() => ({
    ok: true,
    pid: 100,
    imageName: 'node',
    message: [
      '✓ Stopped browser-link primary (PID 100). Port 127.0.0.1:17529 is now free.',
      'Other browser-link processes:',
      '  PID 300  node browser-link start  ✓ stopped',
    ].join('\n'),
    processes: [
      { pid: 100, command: 'node browser-link', stopped: true },
      { pid: 300, command: 'node browser-link start', stopped: true },
    ],
  })),
}));

import { FreePortView } from './free-port.js';

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('FreePortView', () => {
  test('the confirm copy says every browser-link process is stopped', () => {
    const { lastFrame } = render(<FreePortView language="en" onBack={() => undefined} />);
    expect(lastFrame() ?? '').toContain('every other browser-link');
  });

  test('after confirming, every stopped process is listed', async () => {
    const { lastFrame, stdin } = render(<FreePortView language="en" onBack={() => undefined} />);
    await settle();
    stdin.write('y');
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Stopped browser-link primary (PID 100)');
    expect(frame).toContain('Other browser-link processes:');
    expect(frame).toContain('PID 300  node browser-link start  ✓ stopped');
  });

  test('ES copy', () => {
    const { lastFrame } = render(<FreePortView language="es" onBack={() => undefined} />);
    expect(lastFrame() ?? '').toContain('todos los demás procesos de browser-link');
  });
});
