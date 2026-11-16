import { describe, expect, test } from 'vitest';
import { messages } from './i18n.js';
import {
  compareSemver,
  computeVersionCheck,
  runningInstalledLine,
  shouldShowVersionBanner,
  skewEffectLine,
  updateServerLine,
  versionBannerAction,
  versionSkew,
} from './version-status.js';

const EN = messages('en');
const ES = messages('es');
describe('compareSemver', () => {
  test('orders by major, then minor, then patch, numerically', () => {
    expect(compareSemver('0.41.0', '0.40.9')).toBeGreaterThan(0);
    expect(compareSemver('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.41.0', '0.41.0')).toBe(0);
  });

  test('ignores a leading v; a pre-release ranks below its release (semver 2.0)', () => {
    expect(compareSemver('v0.41.0', '0.41.0')).toBe(0);
    expect(compareSemver('0.41.0-rc.1', '0.41.0')).toBeLessThan(0);
  });

  test('treats missing or non-numeric parts as zero', () => {
    expect(compareSemver('0.41', '0.41.0')).toBe(0);
    expect(compareSemver('garbage', '0.0.0')).toBe(0);
  });
});

describe('computeVersionCheck', () => {
  test('still returns extension, server and aligned as before (touched behaviour)', () => {
    const check = computeVersionCheck({ extension: '0.41.0', server: '0.41.0', installed: null });
    expect(check.extension).toBe('0.41.0');
    expect(check.server).toBe('0.41.0');
    expect(check.aligned).toBe(true);
    const drift = computeVersionCheck({ extension: '0.41.0', server: '0.40.0', installed: null });
    expect(drift.aligned).toBe(false);
  });

  test('aligned is null while no server has reported a version', () => {
    const check = computeVersionCheck({ extension: '0.41.0', server: null, installed: null });
    expect(check).toEqual({
      extension: '0.41.0',
      server: null,
      installed: null,
      aligned: null,
      serverOutdated: false,
    });
  });

  test('serverOutdated is true only when the installed version is newer than the running one', () => {
    const outdated = (server: string | null, installed: string | null): boolean =>
      computeVersionCheck({ extension: '0.41.0', server, installed }).serverOutdated;
    expect(outdated('0.40.0', '0.41.0')).toBe(true);
    expect(outdated('0.41.0', '0.41.0')).toBe(false);
    expect(outdated('0.42.0', '0.41.0')).toBe(false);
    expect(outdated('0.41.0', null)).toBe(false);
    expect(outdated(null, '0.41.0')).toBe(false);
  });
});

describe('shouldShowVersionBanner (existing "server behind" banner)', () => {
  test('hidden when aligned and not outdated', () => {
    const check = computeVersionCheck({
      extension: '0.41.0',
      server: '0.41.0',
      installed: '0.41.0',
    });
    expect(shouldShowVersionBanner(check)).toBe(false);
  });

  test('hidden while no server version is known', () => {
    const check = computeVersionCheck({ extension: '0.41.0', server: null, installed: null });
    expect(shouldShowVersionBanner(check)).toBe(false);
  });

  test('shown when the extension and the server differ, as before', () => {
    const check = computeVersionCheck({ extension: '0.41.0', server: '0.40.0', installed: null });
    expect(shouldShowVersionBanner(check)).toBe(true);
  });
});

describe('runningInstalledLine', () => {
  test('says "Server running X · installed Y" when the installed version differs', () => {
    const check = computeVersionCheck({
      extension: '0.41.0',
      server: '0.40.0',
      installed: '0.41.0',
    });
    expect(runningInstalledLine(check, EN)).toBe('Server running 0.40.0 · installed 0.41.0');
  });

  test('is null when the versions match or either one is unknown', () => {
    const line = (server: string | null, installed: string | null): string | null =>
      runningInstalledLine(computeVersionCheck({ extension: '0.41.0', server, installed }), EN);
    expect(line('0.41.0', '0.41.0')).toBeNull();
    expect(line('0.40.0', null)).toBeNull();
    expect(line(null, '0.41.0')).toBeNull();
  });
});

describe('runningInstalledLine in Spanish', () => {
  test('uses the Spanish sentence', () => {
    const check = computeVersionCheck({
      extension: '0.41.0',
      server: '0.40.0',
      installed: '0.41.0',
    });
    expect(runningInstalledLine(check, ES)).toBe('Servidor en ejecución 0.40.0 · instalado 0.41.0');
  });
});

describe('compareSemver pre-releases (semver 2.0, like the server)', () => {
  test('a pre-release ranks below its release', () => {
    expect(compareSemver('1.1.0-beta.1', '1.1.0')).toBeLessThan(0);
    expect(compareSemver('1.1.0', '1.1.0-rc.2')).toBeGreaterThan(0);
  });

  test('a pre-release of a higher core still beats a lower release', () => {
    expect(compareSemver('1.1.0-rc.1', '1.0.9')).toBeGreaterThan(0);
  });

  test('the semver 2.0 spec precedence chain holds', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(compareSemver(chain[i]!, chain[i + 1]!)).toBeLessThan(0);
      expect(compareSemver(chain[i + 1]!, chain[i]!)).toBeGreaterThan(0);
    }
  });

  test('build metadata is ignored', () => {
    expect(compareSemver('1.1.0+build.5', '1.1.0')).toBe(0);
    expect(compareSemver('1.1.0-rc.1+a', '1.1.0-rc.1+b')).toBe(0);
  });
});

describe('versionSkew (both directions)', () => {
  const skew = (extension: string, server: string | null): string | null =>
    versionSkew(computeVersionCheck({ extension, server, installed: null }));

  test('extension older than the server', () => {
    expect(skew('1.0.2', '1.1.0')).toBe('extension-older');
  });

  test('extension newer than the server', () => {
    expect(skew('1.1.0', '1.0.2')).toBe('extension-newer');
  });

  test('none when equal, unknown, or only the spelling differs', () => {
    expect(skew('1.1.0', '1.1.0')).toBeNull();
    expect(skew('1.1.0', null)).toBeNull();
    expect(skew('1.1.0', 'v1.1.0')).toBeNull();
  });
});

describe('skewEffectLine (what does not work until it is fixed)', () => {
  const line = (extension: string, server: string, t = EN): string | null =>
    skewEffectLine(computeVersionCheck({ extension, server, installed: null }), t);

  test('older extension across 1.1.0: reload it, and the Admin window cannot save', () => {
    expect(line('1.0.2', '1.1.0')).toBe(
      'This extension (1.0.2) is older than the server (1.1.0): reload it in chrome://extensions. ' +
        'Until then the Admin window saves nothing, snapshot and find answers are withheld while hide-password-values is on, ' +
        "and a selector-mode download can erase Chrome's copy before the server saved the file.",
    );
  });

  test('newer extension across 1.1.0: restart the server, held downloads leave a second copy', () => {
    expect(line('1.1.0', '1.0.2')).toBe(
      'This extension (1.1.0) is newer than the server (1.0.2): the server runs older code. ' +
        'Run browser-link stop and restart your agent (update browser-link first if it is older than 1.1.0). ' +
        'Until then the Admin window only previews changes, and a download held for the server expires and Chrome saves it as well (a second copy).',
    );
  });

  test('a skew that does not cross 1.1.0 names the remedy and the general effect', () => {
    expect(line('1.1.0', '1.1.1')).toBe(
      'This extension (1.1.0) is older than the server (1.1.1): reload it in chrome://extensions. ' +
        'Until then what the server changed after 1.1.0 may not work.',
    );
    expect(line('1.1.2', '1.1.1')).toBe(
      'This extension (1.1.2) is newer than the server (1.1.1): the server runs older code. ' +
        'Run browser-link stop and restart your agent (update browser-link first if it is older than 1.1.2). ' +
        'Until then what the extension changed after 1.1.1 may not work.',
    );
  });

  test('null when there is no skew', () => {
    expect(line('1.1.0', '1.1.0')).toBeNull();
    expect(
      skewEffectLine(
        computeVersionCheck({ extension: '1.1.0', server: null, installed: null }),
        EN,
      ),
    ).toBeNull();
  });

  test('Spanish', () => {
    expect(line('1.0.2', '1.1.0', ES)).toBe(
      'Esta extensión (1.0.2) es anterior al servidor (1.1.0): recárguela en chrome://extensions. ' +
        'Mientras tanto la ventana Admin no guarda nada, las respuestas de snapshot y find se retienen con hide-password-values activado, ' +
        'y una descarga en modo selector puede borrar la copia de Chrome antes de que el servidor guarde el archivo.',
    );
    expect(line('1.1.0', '1.0.2', ES)).toBe(
      'Esta extensión (1.1.0) es más nueva que el servidor (1.0.2): el servidor ejecuta código anterior. ' +
        'Ejecute browser-link stop y reinicie su agente (antes actualice browser-link si es anterior a 1.1.0). ' +
        'Mientras tanto la ventana Admin solo muestra la vista previa de los cambios, y una descarga retenida para el servidor vence y Chrome también la guarda (una segunda copia).',
    );
  });
});

describe('versionBannerAction and updateServerLine', () => {
  const check = (extension: string, server: string | null) =>
    computeVersionCheck({ extension, server, installed: null });

  test('extension newer than the server: update the server, not chrome://extensions', () => {
    expect(versionBannerAction(check('1.1.1', '1.1.0'))).toBe('update-server');
    expect(updateServerLine(check('1.1.1', '1.1.0'), EN)).toBe(
      'To update the server, run npm install -g @jobshimo/browser-link@1.1.1 in a terminal, then browser-link stop, and restart your agent.',
    );
    expect(updateServerLine(check('1.1.1', '1.1.0'), ES)).toBe(
      'Para actualizar el servidor, ejecute npm install -g @jobshimo/browser-link@1.1.1 en una terminal, después browser-link stop, y reinicie su agente.',
    );
  });

  test('extension older, or direction unknown: the chrome://extensions button, no update line', () => {
    for (const c of [check('1.1.0', '1.1.1'), check('1.1.0', 'v1.1.0'), check('1.1.0', null)]) {
      expect(versionBannerAction(c)).toBe('open-extensions');
      expect(updateServerLine(c, EN)).toBeNull();
    }
  });
});
