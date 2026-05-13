import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { CheckRow, FooterKeys, KeyCap, SectionHead } from '../primitives/index.js';
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

/* Permissions — pick which MCP tools to expose.
 *
 * v0.9.0 layout (screens2.jsx → ScreenPermissions):
 *   - Presets as a horizontal pill row at top. The currently-cursor'd
 *     preset is rendered inverse (the "selected" pill); Enter applies it.
 *   - Tools grouped by family (Browser bridge, Persistent UI map). Each
 *     family head shows a `N / total enabled` hint.
 *   - Sticky bottom save bar when dirty — shows pending change count,
 *     `s save · d discard` keycaps, and an italic note that changes
 *     take effect on the next tool call.
 *
 * The change-count tracking and discard action are new — discard rolls
 * the working `disabled` back to `savedDisabled`. Save and the existing
 * logic stay unchanged.
 */

const PERM_I18N: Record<
  Language,
  {
    title: string;
    intro: string;
    presetsHeader: string;
    bridgeHeader: string;
    mapHeader: string;
    enabled: string;
    unsavedSingle: string;
    unsavedMany: (n: number) => string;
    saved: string;
    restart: string;
    footerNav: string;
    footerToggle: string;
    footerApply: string;
    footerSave: string;
    footerBack: string;
    saveLabel: string;
    discardLabel: string;
  }
> = {
  en: {
    title: 'Permissions — pick which MCP tools to expose',
    intro: 'Apply a preset or toggle individual tools.',
    presetsHeader: 'Presets',
    bridgeHeader: 'Browser bridge',
    mapHeader: 'Persistent UI map',
    enabled: 'enabled',
    unsavedSingle: 'Unsaved: 1 change since save',
    unsavedMany: (n) => `Unsaved: ${n} changes since save`,
    saved: 'Saved.',
    restart: 'changes apply on the next tool call — no MCP client restart needed',
    footerNav: 'navigate',
    footerToggle: 'toggle',
    footerApply: 'apply preset',
    footerSave: 'save',
    footerBack: 'back',
    saveLabel: 'save',
    discardLabel: 'discard',
  },
  es: {
    title: 'Permisos — elegí qué tools del MCP se exponen',
    intro: 'Aplicá un preset o cambiá tools individuales.',
    presetsHeader: 'Presets',
    bridgeHeader: 'Bridge del browser',
    mapHeader: 'Mapa persistente',
    enabled: 'activos',
    unsavedSingle: '* 1 cambio sin guardar',
    unsavedMany: (n) => `* ${n} cambios sin guardar`,
    saved: 'Guardado.',
    restart:
      'los cambios tienen efecto en la próxima llamada — no hace falta reiniciar el cliente MCP',
    footerNav: 'moverse',
    footerToggle: 'cambiar',
    footerApply: 'aplicar preset',
    footerSave: 'guardar',
    footerBack: 'volver',
    saveLabel: 'guardar',
    discardLabel: 'descartar',
  },
};

/* `preset` is the single horizontal-pills row; `tool` rows are the
 * individual catalogue entries; `header` is a family heading (not
 * navigable). The cursor visits one preset row even though it visually
 * spans multiple pills — left/right navigation moves between pills. */
type PermRow =
  | { kind: 'preset' }
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

function diffSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n += 1;
  for (const x of b) if (!a.has(x)) n += 1;
  return n;
}

export function PermissionsView({ language, onBack }: PermissionsViewProps) {
  const t = PERM_I18N[language];

  /* Row order:
   *   1 preset row (horizontal pills, single navigable row)
   *   1 bridge header, then bridge tools
   *   1 map header, then map tools
   */
  const rows: PermRow[] = useMemo(() => {
    const r: PermRow[] = [{ kind: 'preset' }];
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
  const [presetCursor, setPresetCursor] = useState(0);
  const [justSaved, setJustSaved] = useState(false);

  const move = (dir: 1 | -1): void => {
    setCursor((idx) => {
      let i = idx;
      for (let n = 0; n < rows.length; n++) {
        i = (i + dir + rows.length) % rows.length;
        if (rows[i].kind !== 'header') return i;
      }
      return idx;
    });
  };

  /* When the cursor is on a preset row, left/right arrows move between
   * pills instead of bumping to the next row. We compute that adjacency
   * here so the handler stays linear. */
  const movePreset = (dir: 1 | -1): void => {
    setPresetCursor((i) => (i + dir + PRESETS.length) % PRESETS.length);
  };

  const toggleTool = (name: string): void => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setJustSaved(false);
  };

  const applyPreset = (preset: PresetDef): void => {
    setDisabled(new Set(preset.disabled));
    setJustSaved(false);
  };

  const save = (): void => {
    const list = sanitizeDisabledTools([...disabled]);
    saveConfig({ disabledTools: list });
    setSavedDisabled(new Set(list));
    setJustSaved(true);
  };

  const discard = (): void => {
    setDisabled(new Set(savedDisabled));
    setJustSaved(false);
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.leftArrow) {
      if (rows[cursor].kind === 'preset') movePreset(-1);
    } else if (key.rightArrow) {
      if (rows[cursor].kind === 'preset') movePreset(1);
    } else if (input === ' ') {
      const row = rows[cursor];
      if (row.kind === 'tool') toggleTool(row.tool.name);
    } else if (key.return) {
      const row = rows[cursor];
      if (row.kind === 'preset') applyPreset(PRESETS[presetCursor]);
    } else if (input === 's' || input === 'S') save();
    else if (input === 'd' || input === 'D') discard();
    else if (input === 'q' || key.escape) onBack();
  });

  const unsaved = setsDiffer(disabled, savedDisabled);
  const changeCount = diffSize(disabled, savedDisabled);

  /* Per-family "N / total enabled" hint for the SectionHead. We compute
   * once per render so each family row reads from a single source. */
  const familyCounts = useMemo(() => {
    let bridgeTotal = 0;
    let bridgeEnabled = 0;
    let mapTotal = 0;
    let mapEnabled = 0;
    for (const tool of TOOL_CATALOGUE) {
      if (tool.family === 'bridge') {
        bridgeTotal += 1;
        if (!disabled.has(tool.name)) bridgeEnabled += 1;
      } else {
        mapTotal += 1;
        if (!disabled.has(tool.name)) mapEnabled += 1;
      }
    }
    return { bridgeTotal, bridgeEnabled, mapTotal, mapEnabled };
  }, [disabled]);

  return (
    <Frame
      title={t.title}
      footer={
        <FooterKeys
          items={[
            { k: `${GLYPHS.up}${GLYPHS.down}`, label: t.footerNav },
            { k: 'Sp', label: t.footerToggle },
            { k: GLYPHS.enter, label: t.footerApply },
            { k: 's', label: t.footerSave },
            { k: 'Esc', label: t.footerBack },
          ]}
        />
      }
    >
      <Text>{t.intro}</Text>

      <SectionHead>{t.presetsHeader}</SectionHead>
      <PresetPills
        presets={PRESETS}
        activeIndex={presetCursor}
        cursorOnPresetRow={rows[cursor].kind === 'preset'}
      />

      <SectionHead
        hint={`${familyCounts.bridgeEnabled} / ${familyCounts.bridgeTotal} ${t.enabled}`}
      >
        {t.bridgeHeader}
      </SectionHead>
      {rows.map((row, i) => {
        if (row.kind !== 'tool' || row.tool.family !== 'bridge') return null;
        return (
          <CheckRow
            key={`bridge-${row.tool.name}`}
            selected={i === cursor}
            on={!disabled.has(row.tool.name)}
            label={row.tool.name}
            hint={row.tool.summary}
          />
        );
      })}

      <SectionHead hint={`${familyCounts.mapEnabled} / ${familyCounts.mapTotal} ${t.enabled}`}>
        {t.mapHeader}
      </SectionHead>
      {rows.map((row, i) => {
        if (row.kind !== 'tool' || row.tool.family !== 'map') return null;
        return (
          <CheckRow
            key={`map-${row.tool.name}`}
            selected={i === cursor}
            on={!disabled.has(row.tool.name)}
            label={row.tool.name}
            hint={row.tool.summary}
          />
        );
      })}

      <Box marginTop={1} flexDirection="column">
        {unsaved ? (
          <SaveBar
            count={changeCount}
            unsavedLabel={changeCount === 1 ? t.unsavedSingle : t.unsavedMany(changeCount)}
            saveLabel={t.saveLabel}
            discardLabel={t.discardLabel}
            restart={t.restart}
          />
        ) : justSaved ? (
          <Text color={COLORS.success}>
            {GLYPHS.success} {t.saved}
          </Text>
        ) : null}
      </Box>
    </Frame>
  );
}

/* Horizontal preset pills. The currently-cursored preset is inverted;
 * the rest render in muted gray. We do NOT render a vertical cursor
 * here — the cursor IS the inverted pill. The screen's main cursor only
 * lands on the preset row as a whole; left/right move between pills. */
function PresetPills({
  presets,
  activeIndex,
  cursorOnPresetRow,
}: {
  presets: readonly PresetDef[];
  activeIndex: number;
  cursorOnPresetRow: boolean;
}) {
  /* When the cursor is on the preset row, the active pill renders
   * inverse + bold (it's the focus target). When the cursor is somewhere
   * else, no pill is inverted — we still highlight the most-recently
   * selected pill in cyan so the user remembers which preset is "set". */
  return (
    <Box>
      <Text color={cursorOnPresetRow ? COLORS.focus : COLORS.muted}>
        {cursorOnPresetRow ? `${GLYPHS.cursor} ` : '  '}
      </Text>
      {presets.map((preset, i) => {
        const isActive = i === activeIndex;
        const last = i === presets.length - 1;
        if (isActive && cursorOnPresetRow) {
          return (
            <Box key={preset.id}>
              <Text inverse bold>{` ${preset.label} `}</Text>
              {!last && <Text color={COLORS.muted}>{'   '}</Text>}
            </Box>
          );
        }
        return (
          <Box key={preset.id}>
            <Text color={isActive ? COLORS.primary : COLORS.muted}> {preset.label} </Text>
            {!last && <Text color={COLORS.muted}>{'   '}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

/* Sticky-feeling save bar — a one-row inverted strip plus keycaps for
 * save / discard plus an italic dim suffix explaining the effect. Lives
 * inline under the catalogue (Ink doesn't have a true fixed-position
 * primitive, but the visual weight of the inverse strip reads as
 * "actionable" against the calmer rows above). */
function SaveBar({
  count: _count,
  unsavedLabel,
  saveLabel,
  discardLabel,
  restart,
}: {
  count: number;
  unsavedLabel: string;
  saveLabel: string;
  discardLabel: string;
  restart: string;
}) {
  return (
    <Box flexDirection="column">
      <Text color={COLORS.warn}>{unsavedLabel}</Text>
      <Box marginTop={1}>
        <KeyCap label="s" />
        <Text color={COLORS.muted}> {saveLabel}</Text>
        <Text color={COLORS.muted} dimColor>
          {`   ${GLYPHS.dot}   `}
        </Text>
        <KeyCap label="d" />
        <Text color={COLORS.muted}> {discardLabel}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={COLORS.muted} italic dimColor>
          {restart}
        </Text>
      </Box>
    </Box>
  );
}
