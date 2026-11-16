import { describe, expect, test } from 'vitest';
import type { AdminActionResult, AdminState } from '@browser-link/shared';
import { messages } from './i18n.js';
import {
  fallbackAdminUi,
  adminUi,
  buildAdminRows,
  createConsoleInfo,
  describeAdminError,
  initialConfirmState,
  nextAction,
  reduceConfirm,
} from './admin-view.js';

const EN = messages('en');
const ES = messages('es');

const UI_ES = {
  language: 'es' as const,
  confirm: 'Confirmar',
  cancel: 'Cancelar',
  apply: 'Aplicar',
  notConnected: 'Conecta una pestaña para administrar el servidor',
  restartRequired: 'Reinicia el servidor para aplicar el cambio',
  changed: 'Cambiado',
};

function state(overrides: Partial<AdminState> = {}): AdminState {
  return {
    version: 1,
    generatedAt: '2026-11-09T10:00:00.000Z',
    ui: UI_ES,
    sections: [
      {
        id: 'status',
        title: 'Estado',
        items: [
          {
            id: 'server.version',
            kind: 'readout',
            label: 'Versión',
            value: '0.42.0',
            writesDisk: false,
          },
          {
            id: 'server.multiAgent',
            kind: 'readout',
            label: 'Multi-agente',
            value: true,
            writesDisk: false,
          },
          { id: 'server.pid', kind: 'readout', label: 'PID', value: 4242, writesDisk: false },
          {
            id: 'update.available',
            kind: 'readout',
            label: 'Actualización',
            value: null,
            writesDisk: false,
          },
        ],
      },
      {
        id: 'setup',
        title: 'Configuración',
        items: [
          {
            id: 'multiAgent',
            kind: 'toggle',
            label: 'Multi-agente',
            description: 'Varios agentes comparten el puente',
            value: false,
            writesDisk: true,
            requiresRestart: true,
          },
          {
            id: 'language',
            kind: 'select',
            label: 'Idioma',
            value: 'es',
            options: [
              { value: 'en', label: 'English' },
              { value: 'es', label: 'Español' },
            ],
            writesDisk: true,
          },
          {
            id: 'downloadsDir',
            kind: 'readout',
            label: 'Descargas',
            value: '/home/u/Downloads',
            hint: 'browser-link config set downloads-dir <path>',
            writesDisk: false,
          },
        ],
      },
      {
        id: 'diagnose',
        title: 'Diagnóstico',
        items: [{ id: 'doctor', kind: 'button', label: 'Ejecutar doctor', writesDisk: false }],
      },
      {
        id: 'reference',
        title: 'Referencia',
        items: [
          {
            id: 'repository',
            kind: 'link',
            label: 'Repositorio',
            value: 'https://github.com/jobshimo/browser-link',
            writesDisk: false,
          },
          {
            id: 'bad.link',
            kind: 'link',
            label: 'Raro',
            value: 'javascript:alert(1)',
            writesDisk: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('buildAdminRows', () => {
  const rows = buildAdminRows(state(), EN);
  const row = (id: string) => {
    const found = rows.find((r) => r.itemId === id);
    if (!found) throw new Error(`no row ${id}`);
    return found;
  };

  test('one row per item, in section then item order, carrying the section id and title', () => {
    expect(rows.map((r) => `${r.sectionId}/${r.itemId}`)).toEqual([
      'status/server.version',
      'status/server.multiAgent',
      'status/server.pid',
      'status/update.available',
      'setup/multiAgent',
      'setup/language',
      'setup/downloadsDir',
      'diagnose/doctor',
      'reference/repository',
      'reference/bad.link',
    ]);
    expect(row('language').sectionTitle).toBe('Configuración');
  });

  test('a readout has no control and stringifies its value; null reads as a dash', () => {
    expect(row('server.version')).toEqual({
      sectionId: 'status',
      sectionTitle: 'Estado',
      itemId: 'server.version',
      kind: 'readout',
      label: 'Versión',
      valueText: '0.42.0',
      control: 'none',
    });
    expect(row('server.pid').valueText).toBe('4242');
    expect(row('server.multiAgent').valueText).toBe('on');
    expect(row('update.available').valueText).toBe('—');
  });

  test('a readout keeps its console hint', () => {
    expect(row('downloadsDir').hint).toBe('browser-link config set downloads-dir <path>');
    expect(row('downloadsDir').control).toBe('none');
  });

  test('a console-only setting renders as its value and command, with no control', () => {
    // The shape the server sends for cdp-direct, a tool and a client registration.
    const consoleOnly = buildAdminRows(
      state({
        sections: [
          {
            id: 'setup',
            title: 'Setup',
            items: [
              {
                id: 'cdpDirectEnabled',
                kind: 'readout',
                label: 'cdp-direct enabled',
                value: 'off',
                writesDisk: false,
                hint: 'browser-link config set cdp-direct.enabled true',
              },
              {
                id: 'tools.browser.evaluate',
                kind: 'readout',
                label: 'Tool browser.evaluate',
                value: 'on',
                writesDisk: false,
                hint: 'browser-link tools disable browser.evaluate',
              },
            ],
          },
          {
            id: 'diagnose',
            title: 'Diagnose',
            items: [
              {
                id: 'client.register.claude',
                kind: 'readout',
                label: 'MCP registration — Claude Code',
                value: 'registered',
                writesDisk: false,
                hint: 'Already registered; to remove it: browser-link uninstall --client claude',
              },
            ],
          },
        ],
      }),
      EN,
    );
    expect(consoleOnly.map((r) => [r.itemId, r.control, r.valueText, r.hint])).toEqual([
      ['cdpDirectEnabled', 'none', 'off', 'browser-link config set cdp-direct.enabled true'],
      ['tools.browser.evaluate', 'none', 'on', 'browser-link tools disable browser.evaluate'],
      [
        'client.register.claude',
        'none',
        'registered',
        'Already registered; to remove it: browser-link uninstall --client claude',
      ],
    ]);
    for (const r of consoleOnly) {
      expect(r.checked).toBeUndefined();
      expect(r.options).toBeUndefined();
      expect(r.disabled).toBeUndefined();
    }
  });

  test('a toggle carries its description and restart flag and reads its boolean', () => {
    expect(row('multiAgent')).toEqual({
      sectionId: 'setup',
      sectionTitle: 'Configuración',
      itemId: 'multiAgent',
      kind: 'toggle',
      label: 'Multi-agente',
      description: 'Varios agentes comparten el puente',
      valueText: 'off',
      control: 'toggle',
      checked: false,
      requiresRestart: true,
    });
  });

  test('a console-only readout (the hide settings) has no control, shows its value and command, and is flagged', () => {
    const s = state();
    s.sections[1]!.items.push(
      {
        id: 'hidePasswordValues',
        kind: 'readout',
        label: 'Ocultar a los agentes el valor de las contraseñas',
        value: 'visibles',
        writesDisk: false,
        consoleOnly: true,
        hint: 'browser-link config set hide-password-values on',
      },
      {
        id: 'activityHideSensitive',
        kind: 'readout',
        label: 'Ocultar los valores sensibles en el registro de actividad',
        value: 'ocultas',
        writesDisk: false,
        consoleOnly: true,
        hint: 'browser-link config set activity.hide-sensitive off',
      },
    );
    const rows = buildAdminRows(s, ES);
    for (const id of ['hidePasswordValues', 'activityHideSensitive']) {
      expect(rows.find((r) => r.itemId === id)).toMatchObject({
        control: 'none',
        consoleOnly: true,
      });
    }
    expect(rows.find((r) => r.itemId === 'hidePasswordValues')).toMatchObject({
      valueText: 'visibles',
      hint: 'browser-link config set hide-password-values on',
    });
    // Only the flagged rows carry the marker; the existing toggles keep theirs.
    expect(rows.filter((r) => r.consoleOnly === true).map((r) => r.itemId)).toEqual([
      'hidePasswordValues',
      'activityHideSensitive',
    ]);
    expect(rows.find((r) => r.itemId === 'multiAgent')).toMatchObject({ control: 'toggle' });
  });

  test('the existing toggles still go through preview and code', () => {
    const request = { id: 'multiAgent', value: true };
    const preview: AdminActionResult = {
      ok: true,
      applied: false,
      needsConfirm: true,
      preview: 'Activar: Multi-agente',
      code: 'c1',
    };
    expect(nextAction(preview, request, UI_ES, ES)).toMatchObject({
      type: 'confirm',
      resend: { id: 'multiAgent', value: true, code: 'c1' },
    });
  });

  test('a toggle without a boolean value is disabled rather than guessed', () => {
    const s = state();
    s.sections[1]!.items[0] = { ...s.sections[1]!.items[0]!, value: 'yes' };
    const toggle = buildAdminRows(s, EN).find((r) => r.itemId === 'multiAgent');
    expect(toggle?.disabled).toBe(true);
  });

  test('a select shows the label of its current option and carries every option', () => {
    expect(row('language')).toMatchObject({
      control: 'select',
      valueText: 'Español',
      selected: 'es',
      options: [
        { value: 'en', label: 'English' },
        { value: 'es', label: 'Español' },
      ],
    });
  });

  test('a select without options is disabled', () => {
    const s = state();
    s.sections[1]!.items[1] = { ...s.sections[1]!.items[1]!, options: [] };
    expect(buildAdminRows(s, EN).find((r) => r.itemId === 'language')?.disabled).toBe(true);
  });

  test('a button has a button control and no value text', () => {
    expect(row('doctor')).toMatchObject({
      control: 'button',
      valueText: '',
      label: 'Ejecutar doctor',
    });
  });

  test('a link to http(s) is a link; anything else degrades to a readout', () => {
    expect(row('repository')).toMatchObject({
      control: 'link',
      href: 'https://github.com/jobshimo/browser-link',
      valueText: 'https://github.com/jobshimo/browser-link',
    });
    expect(row('bad.link').control).toBe('none');
    expect(row('bad.link').href).toBeUndefined();
  });

  test('a malformed state yields no rows instead of throwing', () => {
    expect(buildAdminRows({} as AdminState, EN)).toEqual([]);
    expect(buildAdminRows(null, EN)).toEqual([]);
  });
});

describe('adminUi', () => {
  test('the server strings win when present', () => {
    expect(adminUi(state(), 'en')).toEqual(UI_ES);
  });

  test('English fallback when the state or its ui block is missing', () => {
    expect(adminUi(null, 'en')).toEqual(fallbackAdminUi('en'));
    expect(adminUi({ ...state(), ui: undefined } as unknown as AdminState, 'en')).toEqual(
      fallbackAdminUi('en'),
    );
    expect(fallbackAdminUi('en').notConnected).toBe('Connect a tab to administer the server');
    expect(fallbackAdminUi('en').language).toBe('en');
  });
});

describe('describeAdminError', () => {
  test('not-connected becomes the notConnected text', () => {
    expect(describeAdminError('not-connected', UI_ES, ES)).toBe(UI_ES.notConnected);
    expect(describeAdminError('not-connected', fallbackAdminUi('en'), ES)).toBe(
      'Connect a tab to administer the server',
    );
  });

  test('any other error is shown as is', () => {
    expect(describeAdminError('unknown action', UI_ES, ES)).toBe('unknown action');
  });

  test('the service worker timeout code reads in the interface language', () => {
    expect(describeAdminError('timeout', UI_ES, ES)).toBe(
      'Se agotó el tiempo de espera del servidor.',
    );
    expect(describeAdminError('timeout', UI_ES, EN)).toBe('Timed out waiting for the server.');
  });
});

describe('nextAction', () => {
  const request = { id: 'multiAgent', value: true };

  test('needsConfirm shows the preview with confirm/cancel and re-sends the same action with its code', () => {
    const result: AdminActionResult = {
      ok: true,
      applied: false,
      needsConfirm: true,
      preview: 'Activar multi-agente para todos los agentes',
      code: 'k1',
    };
    expect(nextAction(result, request, UI_ES, ES)).toEqual({
      type: 'confirm',
      preview: 'Activar multi-agente para todos los agentes',
      confirmLabel: 'Confirmar',
      cancelLabel: 'Cancelar',
      resend: { id: 'multiAgent', value: true, code: 'k1' },
    });
  });

  test('applied with requiresRestart says a restart is required and asks for a refresh', () => {
    expect(
      nextAction({ ok: true, applied: true, requiresRestart: true }, request, UI_ES, ES),
    ).toEqual({
      type: 'applied',
      message: UI_ES.restartRequired,
      refresh: true,
    });
  });

  test('applied without restart says changed and carries any output lines', () => {
    expect(
      nextAction(
        { ok: true, applied: true, output: ['ok: port 9876'] },
        { id: 'doctor' },
        UI_ES,
        ES,
      ),
    ).toEqual({ type: 'applied', message: 'Cambiado', output: ['ok: port 9876'], refresh: true });
  });

  test("a refused code shows the server's own sentence, in either language", () => {
    for (const [error, ui, t] of [
      [
        'This confirmation is no longer valid: it expired, was already used or was for a different change. Nothing was changed; try again.',
        UI_ES,
        EN,
      ],
      [
        'Esta confirmación ya no es válida: caducó, ya se usó o correspondía a otro cambio. No se cambió nada; vuelva a intentarlo.',
        UI_ES,
        ES,
      ],
    ] as const) {
      expect(
        nextAction({ ok: false, error }, { id: 'language', value: 'en', code: 'k' }, ui, t),
      ).toEqual({
        type: 'error',
        message: error,
      });
    }
  });

  test('an error is shown, not-connected localised', () => {
    expect(nextAction({ ok: false, error: 'unknown action' }, request, UI_ES, ES)).toEqual({
      type: 'error',
      message: 'unknown action',
    });
    expect(nextAction({ ok: false, error: 'not-connected' }, request, UI_ES, ES)).toEqual({
      type: 'error',
      message: UI_ES.notConnected,
    });
  });

  test('the confirmed re-send omits value when the request had none', () => {
    const result: AdminActionResult = {
      ok: true,
      applied: false,
      needsConfirm: true,
      preview: 'p',
      code: 'k2',
    };
    const action = nextAction(result, { id: 'instructions.install:claude-code' }, UI_ES, ES);
    expect(action.type === 'confirm' && action.resend).toEqual({
      id: 'instructions.install:claude-code',
      code: 'k2',
    });
  });
});

describe('reduceConfirm (idle → confirming → applied | error)', () => {
  const request = { id: 'language', value: 'en' };
  const needsConfirm: AdminActionResult = {
    ok: true,
    applied: false,
    needsConfirm: true,
    preview: 'Cambiar idioma a English',
    code: 'k3',
  };

  test('starts idle', () => {
    expect(initialConfirmState()).toEqual({ phase: 'idle' });
  });

  test('a needsConfirm result moves to confirming with the preview and the pending request', () => {
    expect(
      reduceConfirm(initialConfirmState(), {
        type: 'result',
        request,
        result: needsConfirm,
        ui: UI_ES,
        t: ES,
      }),
    ).toEqual({
      phase: 'confirming',
      preview: 'Cambiar idioma a English',
      pendingRequest: { id: 'language', value: 'en', code: 'k3' },
    });
  });

  test('cancel from confirming returns to idle', () => {
    const confirming = reduceConfirm(initialConfirmState(), {
      type: 'result',
      request,
      result: needsConfirm,
      ui: UI_ES,
      t: ES,
    });
    expect(reduceConfirm(confirming, { type: 'cancel' })).toEqual({ phase: 'idle' });
  });

  test('the confirmed result moves to applied with its message', () => {
    const confirming = reduceConfirm(initialConfirmState(), {
      type: 'result',
      request,
      result: needsConfirm,
      ui: UI_ES,
      t: ES,
    });
    expect(
      reduceConfirm(confirming, {
        type: 'result',
        request: { ...request, code: 'k3' },
        result: { ok: true, applied: true },
        ui: UI_ES,
        t: ES,
      }),
    ).toEqual({ phase: 'applied', message: 'Cambiado' });
  });

  test('applied keeps doctor output lines', () => {
    expect(
      reduceConfirm(initialConfirmState(), {
        type: 'result',
        request: { id: 'doctor' },
        result: { ok: true, applied: true, output: ['a', 'b'] },
        ui: UI_ES,
        t: ES,
      }),
    ).toEqual({ phase: 'applied', message: 'Cambiado', output: ['a', 'b'] });
  });

  test('an error result moves to error', () => {
    expect(
      reduceConfirm(initialConfirmState(), {
        type: 'result',
        request,
        result: { ok: false, error: 'not-connected' },
        ui: UI_ES,
        t: ES,
      }),
    ).toEqual({ phase: 'error', message: UI_ES.notConnected });
  });
});

describe('admin window in Spanish', () => {
  test('the fallback strings follow the interface language', () => {
    const ui = fallbackAdminUi('es');
    expect(ui.language).toBe('es');
    expect(ui.notConnected).toBe('Conecte una pestaña para administrar el servidor');
    expect(ui.confirm).toBe('Confirmar');
    expect(adminUi(null, 'es')).toEqual(ui);
  });

  test('a boolean readout reads in the interface language', () => {
    const rows = buildAdminRows(state(), ES);
    expect(rows.find((r) => r.itemId === 'server.multiAgent')?.valueText).toBe('activado');
  });
});

describe('the console-only info control', () => {
  function mount(t: typeof EN): { button: HTMLButtonElement; panel: HTMLElement } {
    document.body.replaceChildren();
    const info = createConsoleInfo(document, t, 'cdpDirectEnabled');
    document.body.append(info.button, info.panel);
    return info;
  }
  const key = (el: Element, k: string): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  };

  test.each([
    ['en', EN],
    ['es', ES],
  ] as const)('is a focusable button with a non-empty accessible name in %s', (_l, t) => {
    const { button, panel } = mount(t);
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute('aria-label')).toBe(t.adminConsoleOnlyName);
    expect(button.getAttribute('aria-label')?.trim()).not.toBe('');
    expect(button.getAttribute('aria-describedby')).toBe(panel.id);
    expect(panel.textContent).toBe(t.adminConsoleOnlyInfo);
    expect(panel.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('the text says it is changed from the console, in both languages', () => {
    expect(EN.adminConsoleOnlyInfo).toContain('console');
    expect(ES.adminConsoleOnlyInfo).toContain('consola');
  });

  test('click shows the text, a second click hides it, Escape closes it', () => {
    const { button, panel } = mount(EN);
    button.click();
    expect(panel.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(panel.hidden).toBe(true);
    button.click();
    expect(panel.hidden).toBe(false);
    key(button, 'Escape');
    expect(panel.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('hover and keyboard focus show it without a click; leaving or blurring hides it', () => {
    const { button, panel } = mount(EN);
    button.dispatchEvent(new MouseEvent('mouseenter'));
    expect(panel.hidden).toBe(false);
    button.dispatchEvent(new MouseEvent('mouseleave'));
    expect(panel.hidden).toBe(true);
    button.dispatchEvent(new FocusEvent('focus'));
    expect(panel.hidden).toBe(false);
    button.dispatchEvent(new FocusEvent('blur'));
    expect(panel.hidden).toBe(true);
  });

  test('a clicked (pinned) text survives the pointer leaving, and blur closes it', () => {
    const { button, panel } = mount(EN);
    button.dispatchEvent(new MouseEvent('mouseenter'));
    button.click();
    button.dispatchEvent(new MouseEvent('mouseleave'));
    expect(panel.hidden).toBe(false);
    button.dispatchEvent(new FocusEvent('blur'));
    expect(panel.hidden).toBe(true);
  });
});
