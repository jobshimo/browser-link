import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { Frame } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import {
  INSTRUCTIONS_INSTALLERS,
  type ClientId,
  type InstructionsState,
} from '../../agent-instructions/index.js';
import {
  describeState,
  installInstructionsFor,
  statusAll,
  uninstallInstructionsFor,
  type InstructionsReport,
} from '../../commands/instructions.js';
import type { CommonProps } from './types.js';

interface AgentInstructionsI18n {
  title: string;
  intro: string;
  installPrompt: string;
  installed: string;
  outdated: string;
  notInstalled: string;
  noFile: string;
  corrupt: string;
  legacySuffix: string;
  footer: string;
  doneInstall: string;
  doneUninstall: string;
  failInstall: string;
  failUninstall: string;
  refreshHint: string;
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
    installPrompt: 'Pick a client to install / refresh the block. Press u to uninstall.',
    installed: '✓ installed',
    outdated: '⚠ outdated',
    notInstalled: '· not installed',
    noFile: '· no file yet',
    corrupt: '⚠ corrupt (multiple blocks)',
    legacySuffix: 'legacy',
    footer: '↑↓ navigate · ↵ install/refresh · u uninstall · Esc back',
    doneInstall: '✓ Done. Restart your MCP client to pick up the new instructions.',
    doneUninstall: '✓ Removed. The rest of the file was left untouched.',
    failInstall: '✗ Install failed.',
    failUninstall: '✗ Uninstall failed.',
    refreshHint: 'On install: the block is refreshed in place if it already exists.',
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
    installPrompt:
      'Elegí un cliente para instalar / refrescar el bloque. Apretá u para desinstalar.',
    installed: '✓ instalado',
    outdated: '⚠ desactualizado',
    notInstalled: '· no instalado',
    noFile: '· sin archivo todavía',
    corrupt: '⚠ corrupto (múltiples bloques)',
    legacySuffix: 'legacy',
    footer: '↑↓ moverse · ↵ instalar/refrescar · u desinstalar · Esc volver',
    doneInstall: '✓ Listo. Reiniciá tu cliente MCP para tomar las nuevas instrucciones.',
    doneUninstall: '✓ Quitado. El resto del archivo quedó intacto.',
    failInstall: '✗ Falló la instalación.',
    failUninstall: '✗ Falló la desinstalación.',
    refreshHint: 'En instalar: si el bloque ya existe, se reescribe en su lugar.',
  },
};

interface AgentInstructionsViewProps extends CommonProps {
  onBack: () => void;
}

function statusBadge(
  state: InstructionsState,
  t: AgentInstructionsI18n,
): { label: string; color: string } {
  switch (state.kind) {
    case 'installed':
      return {
        label: `${t.installed} (${state.version === null ? t.legacySuffix : `v${state.version}`})`,
        color: 'green',
      };
    case 'installed-outdated':
      return {
        label: `${t.outdated} (${state.version === null ? t.legacySuffix : `v${state.version}`})`,
        color: 'yellow',
      };
    case 'not-installed':
      return { label: t.notInstalled, color: 'gray' };
    case 'no-file':
      return { label: t.noFile, color: 'gray' };
    case 'corrupt':
      return { label: t.corrupt, color: 'yellow' };
  }
}

type LastAction = { kind: 'install' | 'uninstall'; report: InstructionsReport } | null;

export function AgentInstructionsView({ language, onBack }: AgentInstructionsViewProps) {
  const t = I18N[language];
  const [reports, setReports] = useState<InstructionsReport[]>(() => statusAll());
  const [cursor, setCursor] = useState(0);
  const [lastAction, setLastAction] = useState<LastAction>(null);
  // Refresh status when we come back from an install/uninstall round-trip.
  useEffect(() => {
    if (lastAction) setReports(statusAll());
  }, [lastAction]);

  const items = useMemo(() => INSTRUCTIONS_INSTALLERS, []);

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
    <Frame title={t.title} footer={t.footer}>
      <Box flexDirection="column" marginBottom={1}>
        <Text>{t.intro}</Text>
      </Box>
      <Text color="white" bold>
        {t.installPrompt}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {items.map((inst, i) => {
          const r = reports[i];
          const badge = statusBadge(r.state, t);
          const isCursor = i === cursor;
          return (
            <Box key={inst.id} flexDirection="column">
              <Box>
                <Text color={isCursor ? 'cyan' : 'gray'}>{isCursor ? '❯ ' : '  '}</Text>
                <Text color={isCursor ? 'white' : 'gray'} bold={isCursor}>
                  {inst.displayName.padEnd(22)}
                </Text>
                <Text color={badge.color}>{badge.label}</Text>
              </Box>
              <Box marginLeft={2}>
                <Text color="gray" dimColor>
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
              <Text color="green">
                {lastAction.kind === 'install' ? t.doneInstall : t.doneUninstall}
              </Text>
              {lastAction.report.message !== undefined && lastAction.report.message !== '' && (
                <Text color="gray" dimColor>
                  {lastAction.report.message}
                </Text>
              )}
            </>
          ) : (
            <Box flexDirection="column">
              <Text color="red">
                {lastAction.kind === 'install' ? t.failInstall : t.failUninstall}
              </Text>
              {lastAction.report.message !== undefined && lastAction.report.message !== '' && (
                <Box>
                  <Text color="red" wrap="wrap">
                    {lastAction.report.message}
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray" italic dimColor>
          {t.refreshHint} {describeState(reports[cursor]?.state ?? { kind: 'no-file' }, language)}
        </Text>
      </Box>
    </Frame>
  );
}
