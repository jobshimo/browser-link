import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { CheckRow, FooterKeys, SectionHead } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { loadConfig, saveConfig } from '../../config.js';
import type { CommonProps } from './types.js';

/* Multi-agent toggle screen. v0.9.0 layout (screens2.jsx → ScreenMultiAgent):
 *   - "Multi-agent mode" heading with a PRIMARY inverted badge next to it
 *     when multi-agent is currently saved as ON.
 *   - Body paragraph, then the main CheckRow toggle.
 *   - "Auto-reelect on primary close" with `(advanced)` italic dim suffix,
 *     body paragraph, dimmed-when-inert CheckRow.
 *   - Save/feedback line under the toggles, FooterKeys at the bottom.
 */
interface MultiAgentI18n {
  title: string;
  multiHeader: string;
  multiBody: string;
  multiToggle: string;
  reelectHeader: string;
  reelectAdvanced: string;
  reelectBody: string;
  reelectToggle: string;
  reelectDisabled: string;
  unsaved: string;
  saved: string;
  restart: string;
  primaryBadge: string;
  footerNav: string;
  footerToggle: string;
  footerSave: string;
  footerBack: string;
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
    reelectHeader: 'Auto-reelect on primary close',
    reelectAdvanced: '(advanced)',
    reelectBody: [
      'When the primary client closes, secondary clients lose the bridge.',
      'With auto-reelect ON, one of them takes over the primary role',
      'automatically (race on bind). With it OFF, you relaunch your MCP',
      'client manually to reconnect.',
    ].join('\n'),
    reelectToggle: 'Auto-reelect when primary closes',
    reelectDisabled: '(enable multi-agent first)',
    unsaved: '* Unsaved changes — press s to save',
    saved: 'Saved.',
    restart: 'Restart every MCP client for these changes to take effect.',
    primaryBadge: ' PRIMARY ',
    footerNav: 'navigate',
    footerToggle: 'toggle',
    footerSave: 'save',
    footerBack: 'back',
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
    reelectHeader: 'Re-elección automática al cerrar el primary',
    reelectAdvanced: '(avanzado)',
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
    saved: 'Guardado.',
    restart: 'Reiniciá cada cliente MCP para que los cambios tengan efecto.',
    primaryBadge: ' PRIMARY ',
    footerNav: 'moverse',
    footerToggle: 'cambiar',
    footerSave: 'guardar',
    footerBack: 'volver',
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

  const [cursor, setCursor] = useState<'multi' | 'reelect'>('multi');

  const move = (dir: 1 | -1): void => {
    setCursor((c) => {
      if (dir === 1) return c === 'multi' ? 'reelect' : 'multi';
      return c === 'reelect' ? 'multi' : 'reelect';
    });
  };

  const toggle = (): void => {
    if (cursor === 'multi') {
      setMulti((m) => {
        const next = !m;
        if (!next) setReelect(false);
        return next;
      });
    } else {
      if (!multi) return;
      setReelect((r) => !r);
    }
    setJustSaved(false);
  };

  const save = (): void => {
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

  return (
    <Frame
      title={t.title}
      footer={
        <FooterKeys
          items={[
            { k: `${GLYPHS.up}${GLYPHS.down}`, label: t.footerNav },
            { k: 'Sp', label: t.footerToggle },
            { k: 's', label: t.footerSave },
            { k: 'Esc', label: t.footerBack },
          ]}
        />
      }
    >
      <Box>
        <Text color={COLORS.heading} bold>
          {t.multiHeader}
        </Text>
        {savedMulti && (
          <Box marginLeft={2}>
            <Text inverse bold color={COLORS.primary}>
              {t.primaryBadge}
            </Text>
          </Box>
        )}
      </Box>
      <Text>{t.multiBody}</Text>
      <Box marginTop={1}>
        <CheckRow selected={cursor === 'multi'} on={multi} label={t.multiToggle} />
      </Box>

      <SectionHead hint={t.reelectAdvanced}>{t.reelectHeader}</SectionHead>
      <Text>{t.reelectBody}</Text>
      <Box marginTop={1}>
        <CheckRow
          selected={cursor === 'reelect'}
          on={multi ? reelect : false}
          dimmed={!multi}
          label={t.reelectToggle}
          hint={!multi ? t.reelectDisabled : undefined}
        />
      </Box>

      <Box marginTop={1} flexDirection="column">
        {unsaved ? (
          <Text color={COLORS.warn}>{t.unsaved}</Text>
        ) : justSaved ? (
          <Text color={COLORS.success}>
            {GLYPHS.success} {t.saved}
          </Text>
        ) : null}
        <Text color={COLORS.muted} italic>
          {t.restart}
        </Text>
      </Box>
    </Frame>
  );
}
