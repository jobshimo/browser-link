import { describe, expect, test } from 'vitest';
import { buildAdminState, type AdminInput } from './descriptor.js';
import type { AdminItem, AdminSection, AdminState } from '../messages.js';

/* S1: one test per section asserting ids, kinds and the en/es labels. The
 * input is plain data, so every test builds the state without touching the
 * disk, the network or a running primary. */

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

function input(over: Partial<AdminInput> = {}): AdminInput {
  return {
    config: { language: 'en', multiAgent: true, autoReelect: true, disabledTools: [] },
    now: NOW,
    version: '0.42.0',
    server: {
      running: { version: '0.42.0', pid: 4242, startedAt: '2026-11-09T10:30:00.000Z' },
      installed: '0.42.0',
      outdated: false,
    },
    tabsConnected: 2,
    ports: { ws: 17529, ipc: 17530 },
    extension: { path: '/ext', connectedVersion: '0.42.0' },
    instructions: [
      { id: 'claude', displayName: 'Claude Code', state: { kind: 'installed', version: '0.42.0' } },
      { id: 'opencode', displayName: 'OpenCode', state: { kind: 'not-installed' } },
    ],
    clients: [
      { id: 'claude', displayName: 'Claude Code', installed: true, registered: true },
      { id: 'opencode', displayName: 'OpenCode', installed: false, registered: false },
    ],
    cdpGrant: { live: false, remainingMs: null },
    update: { latest: '0.42.0', isNewer: false },
    toolNames: ['browser.list_tabs', 'browser.evaluate'],
    downloadsDir: '/data/downloads',
    ...over,
  };
}

function section(state: AdminState, id: AdminSection['id']): AdminSection {
  const found = state.sections.find((s) => s.id === id);
  if (!found) throw new Error(`missing section ${id}`);
  return found;
}

function item(sec: AdminSection, id: string): AdminItem {
  const found = sec.items.find((i) => i.id === id);
  if (!found) throw new Error(`missing item ${id}`);
  return found;
}

function shape(sec: AdminSection): Array<[string, string]> {
  return sec.items.map((i) => [i.id, i.kind]);
}

describe('buildAdminState — envelope', () => {
  test('carries version 1, the generation time, four sections in order and the ui strings', () => {
    const state = buildAdminState(input());
    expect(state.version).toBe(1);
    expect(state.generatedAt).toBe('2026-11-09T12:00:00.000Z');
    expect(state.sections.map((s) => s.id)).toEqual(['status', 'setup', 'diagnose', 'reference']);
    expect(state.ui).toEqual({
      language: 'en',
      confirm: 'Confirm',
      cancel: 'Cancel',
      apply: 'Apply',
      notConnected: 'Connect a tab to manage browser-link from here.',
      restartRequired: 'Restart your MCP client for this change to take effect.',
      changed: 'Saved.',
    });
  });

  test('the language defaults to en and follows config.language', () => {
    expect(buildAdminState(input({ config: {} })).ui.language).toBe('en');
    const es = buildAdminState(input({ config: { language: 'es' } }));
    expect(es.ui.language).toBe('es');
    expect(es.ui.confirm).toBe('Confirmar');
  });

  test('a requested language renders the whole state in it, whatever config.language says', () => {
    const es = buildAdminState(input({ config: { language: 'en' } }), 'es');
    expect(es.ui.language).toBe('es');
    expect(es.ui.confirm).toBe('Confirmar');
    expect(section(es, 'status').title).toBe(
      section(buildAdminState(input({ config: { language: 'es' } })), 'status').title,
    );
    const en = buildAdminState(input({ config: { language: 'es' } }), 'en');
    expect(en.ui.language).toBe('en');
    expect(en.ui.confirm).toBe('Confirm');
  });

  test('the language item keeps the console setting as its value, labelled as such', () => {
    const en = buildAdminState(input({ config: { language: 'es' } }), 'en');
    expect(item(section(en, 'setup'), 'language')).toMatchObject({
      label: 'Console language',
      value: 'es',
    });
    const es = buildAdminState(input({ config: { language: 'en' } }), 'es');
    expect(item(section(es, 'setup'), 'language')).toMatchObject({
      label: 'Idioma de la consola',
      value: 'en',
    });
  });
});

describe('buildAdminState — status section', () => {
  test('ids and kinds: every item is a read-only readout', () => {
    const sec = section(buildAdminState(input()), 'status');
    expect(shape(sec)).toEqual([
      ['status.server', 'readout'],
      ['status.installed', 'readout'],
      ['status.pid', 'readout'],
      ['status.uptime', 'readout'],
      ['status.tabs', 'readout'],
      ['status.ports', 'readout'],
      ['status.multiAgent', 'readout'],
      ['status.extension', 'readout'],
      ['status.instructions.claude', 'readout'],
      ['status.instructions.opencode', 'readout'],
      ['status.cdpDirect', 'readout'],
      ['status.update', 'readout'],
      ['status.activity', 'readout'],
    ]);
    expect(sec.items.every((i) => !i.writesDisk)).toBe(true);
  });

  test('en labels and values for a running, aligned primary', () => {
    const sec = section(buildAdminState(input()), 'status');
    expect(sec.title).toBe('Status');
    expect(item(sec, 'status.server')).toMatchObject({ label: 'Server', value: 'running v0.42.0' });
    expect(item(sec, 'status.pid').value).toBe(4242);
    expect(item(sec, 'status.uptime').value).toBe('1h 30m');
    expect(item(sec, 'status.tabs').value).toBe(2);
    expect(item(sec, 'status.ports').value).toBe('WS 17529 · IPC 17530');
    expect(item(sec, 'status.multiAgent').value).toBe('on');
    expect(item(sec, 'status.extension').value).toBe('v0.42.0 (aligned)');
    expect(item(sec, 'status.instructions.claude')).toMatchObject({
      label: 'Instructions — Claude Code',
      value: 'installed v0.42.0',
    });
    expect(item(sec, 'status.cdpDirect').value).toBe('off');
    expect(item(sec, 'status.update').value).toBe('up to date');
    expect(item(sec, 'status.activity').value).toBe('on');
  });

  test('es labels', () => {
    const sec = section(buildAdminState(input({ config: { language: 'es' } })), 'status');
    expect(sec.title).toBe('Estado');
    expect(item(sec, 'status.server')).toMatchObject({
      label: 'Servidor',
      value: 'en marcha v0.42.0',
    });
    expect(item(sec, 'status.tabs').label).toBe('Pestañas conectadas');
  });

  test('no primary answering: the server rows say so, pid and uptime are empty', () => {
    const sec = section(
      buildAdminState(
        input({
          server: { running: null, installed: '0.42.0', outdated: false },
          tabsConnected: null,
        }),
      ),
      'status',
    );
    expect(item(sec, 'status.server').value).toBe('not running');
    expect(item(sec, 'status.server').hint).toBe(
      'Your MCP client starts it; open a session that uses browser-link.',
    );
    expect(item(sec, 'status.pid').value).toBeNull();
    expect(item(sec, 'status.uptime').value).toBeNull();
    expect(item(sec, 'status.tabs').value).toBeNull();
    expect(item(sec, 'status.extension').value).toBe('unknown');
  });

  test('outdated primary and newer release: hints name the console commands, never an action', () => {
    const sec = section(
      buildAdminState(
        input({
          server: {
            running: { version: '0.41.0', pid: 1, startedAt: '2026-11-09T11:59:00.000Z' },
            installed: '0.42.0',
            outdated: true,
          },
          update: { latest: '0.43.0', isNewer: true },
        }),
      ),
      'status',
    );
    expect(item(sec, 'status.installed').value).toBe('0.42.0 (outdated: restart needed)');
    expect(item(sec, 'status.installed').hint).toBe('browser-link stop');
    expect(item(sec, 'status.update').value).toBe('v0.43.0 available');
    expect(item(sec, 'status.update').hint).toBe('npm install -g @jobshimo/browser-link@latest');
  });
});

describe('buildAdminState — setup section', () => {
  test('ids and kinds, one toggle per catalogue tool, restart flags', () => {
    const sec = section(buildAdminState(input()), 'setup');
    expect(shape(sec)).toEqual([
      ['language', 'select'],
      ['tools.browser.list_tabs', 'toggle'],
      ['tools.browser.evaluate', 'toggle'],
      ['multiAgent', 'toggle'],
      ['autoReelect', 'toggle'],
      ['instructionsAutoRefresh', 'toggle'],
      ['cdpDirectEnabled', 'toggle'],
      ['cdpDirectPort', 'readout'],
      ['cdpDirectGrantTtlMinutes', 'select'],
      ['activityEnabled', 'toggle'],
      ['activityRecordPayloads', 'toggle'],
      ['downloadsDir', 'readout'],
      ['idleTtl', 'readout'],
      ['flowRecording', 'readout'],
    ]);
    for (const it of sec.items) expect(it.writesDisk).toBe(it.kind !== 'readout');
    expect(item(sec, 'multiAgent').requiresRestart).toBe(true);
    expect(item(sec, 'autoReelect').requiresRestart).toBe(true);
    expect(item(sec, 'instructionsAutoRefresh').requiresRestart).toBe(true);
    expect(item(sec, 'cdpDirectEnabled').requiresRestart).toBeUndefined();
  });

  test('values reflect the config: disabled tools are off, defaults applied', () => {
    const sec = section(
      buildAdminState(input({ config: { disabledTools: ['browser.evaluate'] } })),
      'setup',
    );
    expect(item(sec, 'tools.browser.list_tabs').value).toBe(true);
    expect(item(sec, 'tools.browser.evaluate').value).toBe(false);
    expect(item(sec, 'language').value).toBe('en');
    expect(item(sec, 'language').options).toEqual([
      { value: 'en', label: 'English' },
      { value: 'es', label: 'Español' },
    ]);
    expect(item(sec, 'cdpDirectGrantTtlMinutes').value).toBe('60');
    expect(item(sec, 'cdpDirectPort')).toMatchObject({
      value: 9222,
      hint: 'browser-link config set cdp-direct.port <port>',
    });
    expect(item(sec, 'downloadsDir')).toMatchObject({
      value: '/data/downloads',
      hint: 'browser-link config set downloads.dir <absolute-path|default>',
    });
  });

  test('a grant TTL outside the common options is still listed as the current option', () => {
    const sec = section(
      buildAdminState(input({ config: { cdpDirectGrantTtlMinutes: 7 } })),
      'setup',
    );
    const ttl = item(sec, 'cdpDirectGrantTtlMinutes');
    expect(ttl.value).toBe('7');
    expect(ttl.options?.some((o) => o.value === '7')).toBe(true);
  });

  test('en and es labels', () => {
    const en = section(buildAdminState(input()), 'setup');
    expect(en.title).toBe('Setup');
    expect(item(en, 'multiAgent').label).toBe('Multi-agent mode');
    expect(item(en, 'tools.browser.evaluate').label).toBe('Tool browser.evaluate');
    const es = section(buildAdminState(input({ config: { language: 'es' } })), 'setup');
    expect(es.title).toBe('Configuración');
    expect(item(es, 'multiAgent').label).toBe('Modo multi-agente');
    expect(item(es, 'tools.browser.evaluate').label).toBe('Tool browser.evaluate');
    expect(item(es, 'idleTtl').hint).toBe(
      'Se cambia desde el popup (Desconexión por inactividad) o con browser-link config set idle-ttl',
    );
  });
});

describe('buildAdminState — diagnose section', () => {
  test('ids and kinds: doctor and update check are read-only buttons, writers are flagged', () => {
    const sec = section(buildAdminState(input()), 'diagnose');
    expect(shape(sec)).toEqual([
      ['doctor', 'button'],
      ['updates.check', 'button'],
      ['instructions.install.claude', 'button'],
      ['instructions.uninstall.claude', 'button'],
      ['instructions.install.opencode', 'button'],
      ['client.register.claude', 'button'],
      ['stop', 'readout'],
      ['selfUpdate', 'readout'],
    ]);
    expect(item(sec, 'doctor').writesDisk).toBe(false);
    expect(item(sec, 'updates.check').writesDisk).toBe(false);
    expect(item(sec, 'instructions.install.claude').writesDisk).toBe(true);
    expect(item(sec, 'instructions.uninstall.claude').writesDisk).toBe(true);
    expect(item(sec, 'client.register.claude').writesDisk).toBe(true);
  });

  test('stop and self-update are never actions: readouts carrying the console command', () => {
    const sec = section(buildAdminState(input()), 'diagnose');
    expect(item(sec, 'stop')).toMatchObject({ kind: 'readout', value: 'browser-link stop' });
    expect(item(sec, 'selfUpdate')).toMatchObject({
      kind: 'readout',
      value: 'npm install -g @jobshimo/browser-link@latest',
    });
  });

  test('a corrupt instructions file offers no install or uninstall button', () => {
    const sec = section(
      buildAdminState(
        input({
          instructions: [
            {
              id: 'claude',
              displayName: 'Claude Code',
              state: { kind: 'corrupt', reason: 'multiple-begin-markers' },
            },
          ],
        }),
      ),
      'diagnose',
    );
    expect(sec.items.some((i) => i.id.startsWith('instructions.'))).toBe(false);
  });

  test('en and es labels', () => {
    const en = section(buildAdminState(input()), 'diagnose');
    expect(en.title).toBe('Diagnose');
    expect(item(en, 'doctor').label).toBe('Run doctor');
    expect(item(en, 'client.register.claude').label).toBe('Register with Claude Code');
    const es = section(buildAdminState(input({ config: { language: 'es' } })), 'diagnose');
    expect(es.title).toBe('Diagnóstico');
    expect(item(es, 'doctor').label).toBe('Ejecutar doctor');
    expect(item(es, 'client.register.claude').label).toBe('Registrar en Claude Code');
  });
});

describe('buildAdminState — reference section', () => {
  test('ids and kinds', () => {
    const sec = section(buildAdminState(input()), 'reference');
    expect(shape(sec)).toEqual([
      ['about', 'readout'],
      ['repo', 'link'],
      ['extension.path', 'readout'],
    ]);
    expect(item(sec, 'repo').value).toBe('https://github.com/jobshimo/browser-link');
    expect(item(sec, 'extension.path').value).toBe('/ext');
  });

  test('en and es labels', () => {
    const en = section(buildAdminState(input()), 'reference');
    expect(en.title).toBe('Reference');
    expect(item(en, 'repo').label).toBe('GitHub repository');
    const es = section(buildAdminState(input({ config: { language: 'es' } })), 'reference');
    expect(es.title).toBe('Referencia');
    expect(item(es, 'repo').label).toBe('Repositorio en GitHub');
    expect(item(es, 'extension.path').label).toBe('Carpeta de la extensión');
  });
});
