import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys } from '../primitives/index.js';
import {
  restoreDefaultConfig,
  type RestoreDefaultsResult,
  type UnreadableConfig,
} from '../../config.js';
import { formatRestoreResult } from '../../commands/config.js';
import type { CommonProps } from './types.js';

/* Unreadable config.json — the console's first screen while config.json
 * cannot be read, instead of the product notice. It says what is wrong (the
 * file and the error) and offers the two ways out: restore the defaults
 * (`r`, the same restore and report as `browser-link config restore-defaults
 * --yes`) or quit to fix the file by hand (`q`). Enter does nothing here, so
 * a reflex Enter never restores; after a restore, Enter continues. */

const CONFIG_I18N = {
  en: {
    title: 'config.json cannot be read',
    intro:
      'browser-link refuses to work while its config file cannot be read. It will not guess your settings (disabled tools, allowed extension ids, strict mode) from a broken file: no tool call runs and no browser connects.',
    file: 'File:',
    error: 'Error:',
    waysOut: 'Two ways out:',
    restoreChoice:
      'Restore the default settings. A copy of the file is kept next to it; the custom settings in it stop applying until you re-enter them from that copy.',
    quitChoice: 'Quit and fix the file by hand (it must hold one JSON object).',
    failed: 'The restore failed:',
    restoreKey: 'restore defaults',
    quitKey: 'quit',
    continueKey: 'continue',
    languageKey: 'español',
  },
  es: {
    title: 'No se puede leer config.json',
    intro:
      'browser-link se niega a funcionar mientras no se pueda leer su archivo de config. No va a adivinar tu configuración (tools deshabilitadas, ids de extensión permitidos, modo estricto) a partir de un archivo roto: no corre ninguna llamada a tools y no se conecta ningún navegador.',
    file: 'Archivo:',
    error: 'Error:',
    waysOut: 'Dos salidas:',
    restoreChoice:
      'Restaurar la configuración por defecto. Se guarda una copia del archivo al lado; la configuración personalizada que tenía deja de aplicarse hasta que la vuelvas a cargar desde esa copia.',
    quitChoice: 'Salir y arreglar el archivo a mano (tiene que tener un objeto JSON).',
    failed: 'La restauración falló:',
    restoreKey: 'restaurar por defecto',
    quitKey: 'salir',
    continueKey: 'continuar',
    languageKey: 'english',
  },
} as const;

type Phase = { kind: 'ask' } | { kind: 'done'; report: string } | { kind: 'failed'; error: string };

interface ConfigUnreadableProps extends CommonProps {
  problem: UnreadableConfig;
  /** After a restore: go on into the console. */
  onContinue: () => void;
  onQuit: () => void;
  /** `l` swaps the language: the configured one cannot be read. */
  onSwapLang?: () => void;
  /** The restore; default `restoreDefaultConfig`. Tests inject a stub. */
  restore?: () => RestoreDefaultsResult;
}

export function ConfigUnreadableView({
  language,
  problem,
  onContinue,
  onQuit,
  onSwapLang,
  restore = restoreDefaultConfig,
}: ConfigUnreadableProps) {
  const t = CONFIG_I18N[language];
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });

  const runRestore = (): void => {
    try {
      setPhase({ kind: 'done', report: formatRestoreResult(restore(), language) });
    } catch (error) {
      setPhase({ kind: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  };

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onQuit();
      return;
    }
    if (input === 'l' && onSwapLang) {
      onSwapLang();
      return;
    }
    if (phase.kind === 'done') {
      if (key.return) onContinue();
      return;
    }
    // Only this key restores: Enter, Space or y do nothing here.
    if (input === 'r') runRestore();
  });

  const footer =
    phase.kind === 'done' ? (
      <FooterKeys
        items={[
          { k: GLYPHS.enter, label: t.continueKey },
          { k: 'q', label: t.quitKey },
        ]}
      />
    ) : (
      <FooterKeys
        items={[
          { k: 'r', label: t.restoreKey },
          { k: 'q', label: t.quitKey },
          ...(onSwapLang ? [{ k: 'l', label: t.languageKey }] : []),
        ]}
      />
    );

  return (
    <Frame title={`${GLYPHS.warn} ${t.title}`} footer={footer}>
      {phase.kind === 'done' ? (
        <Text>{phase.report}</Text>
      ) : (
        <>
          <Text>{t.intro}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>{`${t.file} ${problem.path}`}</Text>
            <Text color={COLORS.error}>{`${t.error} ${problem.error}`}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>{t.waysOut}</Text>
            <Text>{`  r  ${t.restoreChoice}`}</Text>
            <Text>{`  q  ${t.quitChoice}`}</Text>
          </Box>
          {phase.kind === 'failed' && (
            <Box marginTop={1}>
              <Text color={COLORS.error}>{`${t.failed} ${phase.error}`}</Text>
            </Box>
          )}
        </>
      )}
    </Frame>
  );
}
