import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from './map/paths.js';

/**
 * Small per-user config persisted next to the map DB. Only meant for UX
 * preferences (e.g. "don't show me the welcome screen every time").
 * No domain data ever lives here.
 */
export interface BrowserLinkConfig {
  skipWelcome?: boolean;
  language?: 'en' | 'es';
}

function configFile(): string {
  return join(getDataDir(), 'config.json');
}

export function loadConfig(): BrowserLinkConfig {
  const path = configFile();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as BrowserLinkConfig;
    return {};
  } catch {
    // Corrupt config: behave as if there were none, do not crash.
    return {};
  }
}

export function saveConfig(patch: Partial<BrowserLinkConfig>): BrowserLinkConfig {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });
  const current = loadConfig();
  const next: BrowserLinkConfig = { ...current, ...patch };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}
