import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { Frame } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import { loadConfig, saveConfig } from '../../config.js';
import {
  PRESETS,
  TOOL_CATALOGUE,
  sanitizeDisabledTools,
  type PresetDef,
  type ToolFamily,
  type ToolMeta,
} from '../../permissions.js';
import type { CommonProps } from './types.js';

const PERM_I18N: Record<
  Language,
  {
    title: string;
    intro: string;
    presetsHeader: string;
    bridgeHeader: string;
    mapHeader: string;
    applyPrefix: string;
    unsaved: string;
    saved: string;
    restart: string;
    footer: string;
  }
> = {
  en: {
    title: 'Permissions — pick which MCP tools to expose',
    intro: 'Apply a preset (↵) or toggle individual tools (Space). Press s to save.',
    presetsHeader: 'Presets',
    bridgeHeader: 'Browser bridge',
    mapHeader: 'Persistent UI map',
    applyPrefix: 'Apply: ',
    unsaved: '* Unsaved changes — press s to save',
    saved: '✓ Saved.',
    restart: 'Changes take effect on the next tool call — no MCP client restart needed.',
    footer: '↑↓ navigate · Space toggle · ↵ apply preset · s save · Esc back',
  },
  es: {
    title: 'Permisos — elegí qué tools del MCP se exponen',
    intro: 'Aplicá un preset (↵) o cambiá tools individuales (Espacio). Apretá s para guardar.',
    presetsHeader: 'Presets',
    bridgeHeader: 'Bridge del browser',
    mapHeader: 'Mapa persistente',
    applyPrefix: 'Aplicar: ',
    unsaved: '* Cambios sin guardar — apretá s para guardar',
    saved: '✓ Guardado.',
    restart:
      'Los cambios tienen efecto en la próxima llamada — no hace falta reiniciar el cliente MCP.',
    footer: '↑↓ moverse · Espacio cambiar · ↵ aplicar preset · s guardar · Esc volver',
  },
};

type PermRow =
  | { kind: 'preset'; preset: PresetDef }
  | { kind: 'tool'; tool: ToolMeta }
  | { kind: 'header'; family: ToolFamily };

interface PermissionsViewProps extends CommonProps {
  onBack: () => void;
}

function setsDiffer(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}

export function PermissionsView({ language, onBack }: PermissionsViewProps) {
  const t = PERM_I18N[language];

  const rows: PermRow[] = useMemo(() => {
    const r: PermRow[] = [];
    for (const preset of PRESETS) r.push({ kind: 'preset', preset });
    r.push({ kind: 'header', family: 'bridge' });
    for (const tool of TOOL_CATALOGUE) {
      if (tool.family === 'bridge') r.push({ kind: 'tool', tool });
    }
    r.push({ kind: 'header', family: 'map' });
    for (const tool of TOOL_CATALOGUE) {
      if (tool.family === 'map') r.push({ kind: 'tool', tool });
    }
    return r;
  }, []);

  const initial = useMemo(() => new Set(loadConfig().disabledTools ?? []), []);
  const [savedDisabled, setSavedDisabled] = useState<Set<string>>(initial);
  const [disabled, setDisabled] = useState<Set<string>>(initial);
  const firstNonHeader = rows.findIndex((r) => r.kind !== 'header');
  const [cursor, setCursor] = useState(firstNonHeader);
  const [justSaved, setJustSaved] = useState(false);

  const move = (dir: 1 | -1) => {
    setCursor((idx) => {
      let i = idx;
      for (let n = 0; n < rows.length; n++) {
        i = (i + dir + rows.length) % rows.length;
        if (rows[i].kind !== 'header') return i;
      }
      return idx;
    });
  };

  const toggleTool = (name: string) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setJustSaved(false);
  };

  const applyPreset = (preset: PresetDef) => {
    setDisabled(new Set(preset.disabled));
    setJustSaved(false);
  };

  const save = () => {
    const list = sanitizeDisabledTools([...disabled]);
    saveConfig({ disabledTools: list });
    setSavedDisabled(new Set(list));
    setJustSaved(true);
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (input === ' ') {
      const row = rows[cursor];
      if (row.kind === 'tool') toggleTool(row.tool.name);
    } else if (key.return) {
      const row = rows[cursor];
      if (row.kind === 'preset') applyPreset(row.preset);
    } else if (input === 's' || input === 'S') {
      save();
    } else if (input === 'q' || key.escape) onBack();
  });

  const unsaved = setsDiffer(disabled, savedDisabled);

  return (
    <Frame title={t.title} footer={t.footer}>
      <Box marginBottom={1}>
        <Text color="white">{t.intro}</Text>
      </Box>
      <Box flexDirection="column">
        {rows.map((row, i) => {
          if (row.kind === 'header') {
            const label = row.family === 'bridge' ? t.bridgeHeader : t.mapHeader;
            return (
              <Box key={`h-${i}`} marginTop={1}>
                <Text color="cyan" bold>
                  {label}:
                </Text>
              </Box>
            );
          }
          const isCursor = i === cursor;
          const cursorMark = isCursor ? '❯' : ' ';
          if (row.kind === 'preset') {
            return (
              <Box key={`p-${row.preset.id}`}>
                <Text color={isCursor ? 'cyan' : 'gray'}>{cursorMark} </Text>
                <Text color={isCursor ? 'white' : 'gray'} bold={isCursor}>
                  {t.applyPrefix}
                  {row.preset.label}
                </Text>
              </Box>
            );
          }
          const isDisabled = disabled.has(row.tool.name);
          const checkbox = isDisabled ? '[ ]' : '[x]';
          const checkboxColor = isDisabled ? 'red' : 'green';
          return (
            <Box key={`t-${row.tool.name}`}>
              <Text color={isCursor ? 'cyan' : 'gray'}>{cursorMark} </Text>
              <Text color={checkboxColor}>{checkbox} </Text>
              <Text color={isCursor ? 'white' : isDisabled ? 'gray' : 'white'} bold={isCursor}>
                {row.tool.name.padEnd(28)}
              </Text>
              <Text color="gray" dimColor>
                {' '}
                {row.tool.summary}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {unsaved ? (
          <Text color="yellow">{t.unsaved}</Text>
        ) : justSaved ? (
          <Text color="green">{t.saved}</Text>
        ) : null}
        <Text color="gray" italic>
          {t.restart}
        </Text>
      </Box>
    </Frame>
  );
}
