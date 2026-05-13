import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame, Menu, type MenuItem } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import type { CommonProps } from './types.js';

export type MenuAction =
  | 'register'
  | 'instructions'
  | 'permissions'
  | 'multiAgent'
  | 'extension'
  | 'doctor'
  | 'updates'
  | 'freePort'
  | 'language'
  | 'welcome'
  | 'about'
  | 'repo'
  | 'quit';

interface MenuI18n {
  title: string;
  prompt: string;
  options: Record<MenuAction, string>;
  footer: string;
}

const MENU_I18N: Record<Language, MenuI18n> = {
  en: {
    title: 'browser-link — setup',
    prompt: 'Pick an action',
    footer: '↑↓ navigate · ↵ select · l language · q quit',
    options: {
      register: 'Register browser-link with an MCP client',
      instructions:
        'Agent instructions — drop a trigger block into Claude/OpenCode/Copilot global .md',
      permissions: 'Permissions — pick which MCP tools to expose',
      multiAgent: 'Multi-agent — let multiple MCP clients share one bridge',
      extension: 'Show Chrome extension install steps',
      doctor: 'Run doctor (diagnose current setup)',
      updates: 'Check for updates on npm',
      freePort: 'Free port — stop a stuck browser-link holding 17529',
      language: 'Language — switch between English and Español',
      welcome: 'Show the welcome screen',
      about: 'About / Help — what is this and how it works',
      repo: 'Open the GitHub repository',
      quit: 'Quit',
    },
  },
  es: {
    title: 'browser-link — configuración',
    prompt: 'Elegí una acción',
    footer: '↑↓ moverse · ↵ elegir · l idioma · q salir',
    options: {
      register: 'Registrar browser-link en un cliente MCP',
      instructions:
        'Instrucciones del agente — meter un bloque de triggers en el .md global de Claude/OpenCode/Copilot',
      permissions: 'Permisos — elegí qué tools del MCP se exponen',
      multiAgent: 'Multi-agente — varios clientes MCP comparten el mismo puente',
      extension: 'Ver pasos para instalar la extensión de Chrome',
      doctor: 'Diagnóstico (estado actual de la instalación)',
      updates: 'Buscar actualizaciones en npm',
      freePort: 'Liberar puerto — matar el browser-link colgado en 17529',
      language: 'Idioma — cambiar entre English y Español',
      welcome: 'Mostrar la pantalla de bienvenida',
      about: 'Información / ayuda — qué es esto y cómo funciona',
      repo: 'Abrir el repositorio en GitHub',
      quit: 'Salir',
    },
  },
};

interface MainMenuProps extends CommonProps {
  onSelect: (action: MenuAction) => void;
  onSwapLang: () => void;
  onQuit: () => void;
}

export function MainMenu({ language, onSelect, onSwapLang, onQuit }: MainMenuProps) {
  const t = MENU_I18N[language];
  const items: MenuItem<MenuAction>[] = (
    [
      'register',
      'instructions',
      'permissions',
      'multiAgent',
      'extension',
      'doctor',
      'updates',
      'freePort',
      'language',
      'welcome',
      'about',
      'repo',
      'quit',
    ] as const
  ).map((a) => ({ value: a, label: t.options[a] }));

  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) {
      const v = items[idx].value;
      if (v === 'quit') onQuit();
      else onSelect(v);
    } else if (input === 'q' || key.escape) onQuit();
    else if (input === 'l') onSwapLang();
  });

  return (
    <Frame title={t.title} footer={t.footer}>
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1}>
        <Menu items={items} selectedIndex={idx} />
      </Box>
    </Frame>
  );
}
