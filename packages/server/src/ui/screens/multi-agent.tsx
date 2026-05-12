import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { Frame } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import { loadConfig, saveConfig } from '../../config.js';
import type { CommonProps } from './types.js';

interface MultiAgentI18n {
  title: string;
  multiHeader: string;
  multiBody: string;
  multiToggle: string;
  reelectHeader: string;
  reelectBody: string;
  reelectToggle: string;
  reelectDisabled: string;
  unsaved: string;
  saved: string;
  restart: string;
  footer: string;
}

const MULTI_AGENT_I18N: Record<Language, MultiAgentI18n> = {
  en: {
    title: 'Multi-agent — let multiple MCP clients share one browser-link',
    multiHeader: 'Multi-agent mode',
    multiBody: [
      'browser-link normally binds 127.0.0.1:17529 from the first MCP',
      'client that starts it. Other clients (Claude + Copilot + OpenCode at',
      'the same time) crash with "port in use".',
      '',
      'When multi-agent is ON, the second instance becomes a proxy that',
      'forwards MCP requests to the first one over an internal port',
      '(127.0.0.1:17530, kernel-validated like the main one). All agents',
      'end up sharing the same connected Chrome tabs and the same',
      'persistent UI map.',
    ].join('\n'),
    multiToggle: 'Enable multi-agent mode',
    reelectHeader: 'Auto-reelect on primary close (advanced)',
    reelectBody: [
      'When the primary client closes, secondary clients lose the bridge.',
      'With auto-reelect ON, one of them takes over the primary role',
      'automatically (race on bind). With it OFF, you relaunch your MCP',
      'client manually to reconnect.',
    ].join('\n'),
    reelectToggle: 'Auto-reelect when primary closes',
    reelectDisabled: '(enable multi-agent first)',
    unsaved: '* Unsaved changes — press s to save',
    saved: '✓ Saved.',
    restart: 'Restart every MCP client for these changes to take effect.',
    footer: '↑↓ navigate · Space toggle · s save · Esc back',
  },
  es: {
    title: 'Multi-agente — varios clientes MCP comparten el mismo puente',
    multiHeader: 'Modo multi-agente',
    multiBody: [
      'browser-link normalmente bindea 127.0.0.1:17529 desde el primer',
      'cliente MCP que lo arranca. Otros clientes (Claude + Copilot +',
      'OpenCode al mismo tiempo) caen con "port in use".',
      '',
      'Con multi-agente activado, el segundo proceso se vuelve un proxy',
      'que reenvía los pedidos MCP al primero por un puerto interno',
      '(127.0.0.1:17530, validado por kernel igual que el principal).',
      'Todos los agentes terminan viendo las mismas pestañas conectadas',
      'y el mismo mapa persistente.',
    ].join('\n'),
    multiToggle: 'Activar modo multi-agente',
    reelectHeader: 'Re-elección automática al cerrar el primary (avanzado)',
    reelectBody: [
      'Cuando el cliente primary cierra, los secundarios pierden el',
      'puente. Con re-elección automática activada, uno de ellos toma el',
      'rol de primary automáticamente (race en el bind). Con ella',
      'desactivada, tenés que relanzar el cliente MCP a mano para',
      'reconectar.',
    ].join('\n'),
    reelectToggle: 'Re-elegir automáticamente al cerrar el primary',
    reelectDisabled: '(activá primero multi-agente)',
    unsaved: '* Cambios sin guardar — apretá s para guardar',
    saved: '✓ Guardado.',
    restart: 'Reiniciá cada cliente MCP para que los cambios tengan efecto.',
    footer: '↑↓ moverse · Espacio cambiar · s guardar · Esc volver',
  },
};

interface MultiAgentViewProps extends CommonProps {
  onBack: () => void;
}

export function MultiAgentView({ language, onBack }: MultiAgentViewProps) {
  const t = MULTI_AGENT_I18N[language];

  const initialCfg = useMemo(() => loadConfig(), []);
  const [savedMulti, setSavedMulti] = useState<boolean>(initialCfg.multiAgent === true);
  const [savedReelect, setSavedReelect] = useState<boolean>(initialCfg.autoReelect === true);
  const [multi, setMulti] = useState<boolean>(savedMulti);
  const [reelect, setReelect] = useState<boolean>(savedReelect);
  const [justSaved, setJustSaved] = useState(false);

  // Only the two toggles are navigable.
  const [cursor, setCursor] = useState<'multi' | 'reelect'>('multi');

  const move = (dir: 1 | -1) => {
    setCursor((c) => {
      if (dir === 1) return c === 'multi' ? 'reelect' : 'multi';
      return c === 'reelect' ? 'multi' : 'reelect';
    });
  };

  const toggle = () => {
    if (cursor === 'multi') {
      setMulti((m) => {
        const next = !m;
        // Turning multi off also clears the working reelect state, matching
        // the config normalisation rule (autoReelect implies multiAgent).
        if (!next) setReelect(false);
        return next;
      });
    } else {
      // Auto-reelect can only be turned on when multi is on.
      if (!multi) return;
      setReelect((r) => !r);
    }
    setJustSaved(false);
  };

  const save = () => {
    saveConfig({ multiAgent: multi, autoReelect: multi ? reelect : false });
    setSavedMulti(multi);
    setSavedReelect(multi ? reelect : false);
    setJustSaved(true);
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (input === ' ') toggle();
    else if (input === 's' || input === 'S') save();
    else if (input === 'q' || key.escape) onBack();
  });

  const unsaved = multi !== savedMulti || reelect !== savedReelect;

  const checkbox = (on: boolean, dim: boolean): { mark: string; color: string } => {
    if (dim) return { mark: '[ ]', color: 'gray' };
    return on ? { mark: '[x]', color: 'green' } : { mark: '[ ]', color: 'red' };
  };

  const multiBox = checkbox(multi, false);
  const reelectBox = checkbox(multi ? reelect : false, !multi);

  return (
    <Frame title={t.title} footer={t.footer}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>
          {t.multiHeader}
        </Text>
        <Text>{t.multiBody}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={cursor === 'multi' ? 'cyan' : 'gray'}>{cursor === 'multi' ? '❯ ' : '  '}</Text>
        <Text color={multiBox.color}>{multiBox.mark} </Text>
        <Text color={cursor === 'multi' ? 'white' : 'gray'} bold={cursor === 'multi'}>
          {t.multiToggle}
        </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>
          {t.reelectHeader}
        </Text>
        <Text>{t.reelectBody}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={cursor === 'reelect' ? 'cyan' : 'gray'}>
          {cursor === 'reelect' ? '❯ ' : '  '}
        </Text>
        <Text color={reelectBox.color}>{reelectBox.mark} </Text>
        <Text
          color={!multi ? 'gray' : cursor === 'reelect' ? 'white' : 'gray'}
          bold={cursor === 'reelect' && multi}
        >
          {t.reelectToggle}
          {!multi && (
            <Text color="gray" dimColor>
              {' '}
              {t.reelectDisabled}
            </Text>
          )}
        </Text>
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
