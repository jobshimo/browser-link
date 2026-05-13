import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { Badge, FooterKeys, KeyCap, type BadgeKind } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import {
  INSTRUCTIONS_INSTALLERS,
  type ClientId,
  type InstructionsState,
} from '../../agent-instructions/index.js';
import {
  describeState,
  displayNameColumnWidth,
  installInstructionsFor,
  statusAll,
  uninstallInstructionsFor,
  type InstructionsReport,
} from '../../commands/instructions.js';
import type { CommonProps } from './types.js';

/* Agent instructions installer. v0.9.0 layout reshapes the row as:
 *
 *   ❯ Claude Code   [✓ installed (v3)]
 *       ~/.claude/CLAUDE.md
 *
 * — cursor, client name padded to the column width, status badge inline
 * (right of the name, NOT right-aligned to the frame), file path on a
 * dim sub-row indented by two.
 *
 * Hint at the bottom is the existing describeState() copy.
 */
interface AgentInstructionsI18n {
  title: string;
  intro: string;
  installPrompt: string;
  installPromptHint: string;
  installed: string;
  outdated: string;
  notInstalled: string;
  noFile: string;
  corrupt: string;
  legacySuffix: string;
  doneInstall: string;
  doneUninstall: string;
  failInstall: string;
  failUninstall: string;
  refreshHint: string;
  footerNav: string;
  footerInstall: string;
  footerUninstall: string;
  footerBack: string;
}

const I18N: Record<Language, AgentInstructionsI18n> = {
  en: {
    title: 'Agent instructions — browser-link awareness in global agent .md files',
    intro: [
      "Inserts a fenced block into each agent's global .md (Claude, OpenCode,",
      'Copilot CLI) so the agent reaches for browser.* tools reflexively — no',
      'project CLAUDE.md required. The block lists triggers ("user reports a UI',
      'bug → call browser.snapshot first") and is rewritten in place on update.',
    ].join('\n'),
    installPrompt: 'Pick a client to install / refresh the block.',
    installPromptHint: 'to uninstall.',
    installed: 'installed',
    outdated: 'outdated',
    notInstalled: 'not installed',
    noFile: 'no file yet',
    corrupt: 'corrupt (multiple blocks)',
    legacySuffix: 'legacy',
    doneInstall: 'Done. Restart your MCP client to pick up the new instructions.',
    doneUninstall: 'Removed. The rest of the file was left untouched.',
    failInstall: 'Install failed.',
    failUninstall: 'Uninstall failed.',
    refreshHint:
      'On install: the block is refreshed in place if it already exists. The rest of the file is left untouched.',
    footerNav: 'navigate',
    footerInstall: 'install / refresh',
    footerUninstall: 'uninstall',
    footerBack: 'back',
  },
  es: {
    title: 'Instrucciones del agente — browser-link en los .md globales de cada cliente',
    intro: [
      'Mete un bloque fenced en el .md global de cada agente (Claude, OpenCode,',
      'Copilot CLI) para que el agente alcance reflejamente las tools browser.* —',
      'sin necesidad de un CLAUDE.md por proyecto. El bloque lista triggers',
      '("el usuario reporta un bug de UI → llamá a browser.snapshot primero") y',
      'se rescribe in place al actualizar.',
    ].join('\n'),
    installPrompt: 'Elegí un cliente para instalar / refrescar el bloque.',
    installPromptHint: 'para desinstalar.',
    installed: 'instalado',
    outdated: 'desactualizado',
    notInstalled: 'no instalado',
    noFile: 'sin archivo todavía',
    corrupt: 'corrupto (múltiples bloques)',
    legacySuffix: 'legacy',
    doneInstall: 'Listo. Reiniciá tu cliente MCP para tomar las nuevas instrucciones.',
    doneUninstall: 'Quitado. El resto del archivo quedó intacto.',
    failInstall: 'Falló la instalación.',
    failUninstall: 'Falló la desinstalación.',
    refreshHint:
      'En instalar: si el bloque ya existe, se reescribe en su lugar. El resto del archivo queda intacto.',
    footerNav: 'moverse',
    footerInstall: 'instalar / refrescar',
    footerUninstall: 'desinstalar',
    footerBack: 'volver',
  },
};

interface AgentInstructionsViewProps extends CommonProps {
  onBack: () => void;
  /** Optional initial cursor target. When the user lands on this screen via
   * the `i` hotkey from the main menu, the cursor is auto-positioned on
   * the first outdated client so the next Enter refreshes it. Falls back
   * to row 0 when omitted or when the requested client is not present. */
  initialCursorClient?: ClientId;
}

interface BadgeSpec {
  kind: BadgeKind;
  label: string;
}

function statusBadge(state: InstructionsState, t: AgentInstructionsI18n): BadgeSpec {
  switch (state.kind) {
    case 'installed': {
      const versionSuffix = state.version === null ? t.legacySuffix : `v${state.version}`;
      return { kind: 'ok', label: `${t.installed} (${versionSuffix})` };
    }
    case 'installed-outdated': {
      const versionSuffix = state.version === null ? t.legacySuffix : `v${state.version}`;
      return { kind: 'warn', label: `${t.outdated} (${versionSuffix})` };
    }
    case 'not-installed':
      return { kind: 'off', label: t.notInstalled };
    case 'no-file':
      return { kind: 'noFile', label: t.noFile };
    case 'corrupt':
      return { kind: 'warn', label: t.corrupt };
  }
}

type LastAction = { kind: 'install' | 'uninstall'; report: InstructionsReport } | null;

export function AgentInstructionsView({
  language,
  onBack,
  initialCursorClient,
}: AgentInstructionsViewProps) {
  const t = I18N[language];
  const [reports, setReports] = useState<InstructionsReport[]>(() => statusAll());
  const items = useMemo(() => INSTRUCTIONS_INSTALLERS, []);

  const initialIndex = useMemo(() => {
    if (!initialCursorClient) return 0;
    const i = items.findIndex((it) => it.id === initialCursorClient);
    return i >= 0 ? i : 0;
  }, [initialCursorClient, items]);
  const [cursor, setCursor] = useState(initialIndex);
  const [lastAction, setLastAction] = useState<LastAction>(null);

  useEffect(() => {
    if (lastAction) setReports(statusAll());
  }, [lastAction]);

  const nameColumnWidth = useMemo(
    () => displayNameColumnWidth(items.map((i) => i.displayName)),
    [items],
  );

  const runAction = (client: ClientId, action: 'install' | 'uninstall'): void => {
    const report =
      action === 'install' ? installInstructionsFor(client) : uninstallInstructionsFor(client);
    setLastAction({ kind: action, report });
  };

  useInput((input, key) => {
    if (key.upArrow) setCursor((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setCursor((i) => (i + 1) % items.length);
    else if (key.return) runAction(items[cursor].id, 'install');
    else if (input === 'u' || input === 'U') runAction(items[cursor].id, 'uninstall');
    else if (key.escape || input === 'q') onBack();
  });

  return (
    <Frame
      title={t.title}
      footer={
        <FooterKeys
          items={[
            { k: `${GLYPHS.up}${GLYPHS.down}`, label: t.footerNav },
            { k: GLYPHS.enter, label: t.footerInstall },
            { k: 'u', label: t.footerUninstall },
            { k: 'Esc', label: t.footerBack },
          ]}
        />
      }
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text>{t.intro}</Text>
      </Box>
      <Box>
        <Text color="white" bold>
          {t.installPrompt}
        </Text>
        <Text color={COLORS.muted} dimColor italic>
          {'  '}Press{' '}
        </Text>
        <KeyCap label="u" />
        <Text color={COLORS.muted} dimColor italic>
          {' '}
          {t.installPromptHint}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {items.map((inst, i) => {
          const r = reports[i];
          const badge = statusBadge(r.state, t);
          const isCursor = i === cursor;
          return (
            <Box key={inst.id} flexDirection="column">
              <Box>
                <Text color={isCursor ? COLORS.focus : COLORS.muted}>
                  {isCursor ? `${GLYPHS.cursor} ` : '  '}
                </Text>
                <Text color={isCursor ? 'white' : COLORS.muted} bold={isCursor}>
                  {inst.displayName.padEnd(nameColumnWidth)}
                </Text>
                <Text> </Text>
                <Badge kind={badge.kind} label={badge.label} />
              </Box>
              <Box marginLeft={4}>
                <Text color={COLORS.muted} dimColor>
                  {r.filePath}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      {lastAction && (
        <Box flexDirection="column" marginTop={1}>
          {lastAction.report.ok ? (
            <>
              <Text color={COLORS.success}>
                {GLYPHS.success} {lastAction.kind === 'install' ? t.doneInstall : t.doneUninstall}
              </Text>
              {lastAction.report.message !== undefined && lastAction.report.message !== '' && (
                <Text color={COLORS.muted} dimColor>
                  {lastAction.report.message}
                </Text>
              )}
            </>
          ) : (
            <Box flexDirection="column">
              <Text color={COLORS.error}>
                {GLYPHS.error} {lastAction.kind === 'install' ? t.failInstall : t.failUninstall}
              </Text>
              {lastAction.report.message !== undefined && lastAction.report.message !== '' && (
                <Box>
                  <Text color={COLORS.error} wrap="wrap">
                    {lastAction.report.message}
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={COLORS.muted} italic dimColor>
          {t.refreshHint} {describeState(reports[cursor]?.state ?? { kind: 'no-file' }, language)}
        </Text>
      </Box>
    </Frame>
  );
}
