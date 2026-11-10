import { describe, expect, test } from 'vitest';
import { ADMIN_I18N } from './i18n.js';

/* The Spanish admin strings are shown by the extension's Admin window and the
 * console: neutral professional Spanish, the formal "usted" the extension and
 * the product notice use, never regional voseo. */

const es = ADMIN_I18N.es;

/** Every Spanish string, functions called with sample values. */
function allSpanish(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'function') {
      for (const sample of [
        ['x', 'y'],
        [null, true],
        [{ kind: 'corrupt' }],
        [{ kind: 'installed', version: null }],
      ]) {
        try {
          const r: unknown = (value as (...a: unknown[]) => unknown)(...sample);
          if (typeof r === 'string') out.push(r);
        } catch {
          // sample not meaningful for this entry
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(es);
  return out;
}

describe('ADMIN_I18N.es', () => {
  test('uses neutral Spanish, not voseo', () => {
    const voseo =
      /(?<!\p{L})(acá|vos|conectá|conectás|reiniciá|abrí|recargá|actualizá|arreglalo|usá|tenés|podés|querés|elegí|hacé)(?!\p{L})/iu;
    expect(allSpanish().filter((s) => voseo.test(s))).toEqual([]);
  });

  test('keeps the meaning of the rewritten strings', () => {
    expect(es.ui.notConnected).toBe(
      'Conecte una pestaña para administrar browser-link desde aquí.',
    );
    expect(es.ui.restartRequired).toBe('Reinicie su cliente MCP para que el cambio surta efecto.');
    expect(es.serverNotRunningHint).toBe(
      'Lo inicia su cliente MCP; abra una sesión que use browser-link.',
    );
    expect(es.tabsUnknownHint).toBe(
      'Solo lo sabe el servidor en marcha; abra el popup de la extensión.',
    );
    expect(es.extensionMismatch('1', '2')).toBe(
      'v1 (servidor v2: recargue o actualice uno de los dos)',
    );
    expect(es.instructionsState({ kind: 'corrupt' } as never)).toBe('corrupto (corríjalo a mano)');
    expect(es.aboutText).toBe(
      'browser-link es un servidor MCP que deja a los agentes ver y actuar sobre las pestañas de Chrome que usted conecte.',
    );
  });
});
