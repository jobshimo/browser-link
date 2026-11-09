import { describe, expect, test } from 'vitest';
import { NOTICE as SHARED_NOTICE } from '@browser-link/shared';
import {
  NOTICE,
  NOTICE_ACKNOWLEDGED_STORAGE_KEY,
  noticeAcknowledgeLabel,
  noticeCloseLabel,
  noticeFull,
  noticeLanguage,
  noticeShortLine,
  noticeShortLineParts,
  shouldShowNoticeBeforeConnect,
} from './notice-policy.js';

describe('notice copy', () => {
  test('is value-identical to the shared source (the popup build cannot import it at runtime)', () => {
    expect(NOTICE).toEqual(SHARED_NOTICE);
  });
});

describe('NOTICE_ACKNOWLEDGED_STORAGE_KEY', () => {
  test('is the agreed chrome.storage.local key', () => {
    expect(NOTICE_ACKNOWLEDGED_STORAGE_KEY).toBe('noticeAcknowledged');
  });
});

describe('noticeLanguage', () => {
  test('Spanish for any es* browser language', () => {
    expect(noticeLanguage('es')).toBe('es');
    expect(noticeLanguage('es-ES')).toBe('es');
    expect(noticeLanguage('es-419')).toBe('es');
    expect(noticeLanguage('ES-mx')).toBe('es');
  });

  test('English for everything else, including a missing language', () => {
    expect(noticeLanguage('en-US')).toBe('en');
    expect(noticeLanguage('fr')).toBe('en');
    expect(noticeLanguage('')).toBe('en');
    expect(noticeLanguage(undefined)).toBe('en');
  });
});

describe('shouldShowNoticeBeforeConnect', () => {
  test('only a stored literal true skips the notice', () => {
    expect(shouldShowNoticeBeforeConnect(true)).toBe(false);
  });

  test('anything else shows it — never fail open', () => {
    expect(shouldShowNoticeBeforeConnect(undefined)).toBe(true);
    expect(shouldShowNoticeBeforeConnect(false)).toBe(true);
    expect(shouldShowNoticeBeforeConnect(null)).toBe(true);
    expect(shouldShowNoticeBeforeConnect('true')).toBe(true);
    expect(shouldShowNoticeBeforeConnect(1)).toBe(true);
  });
});

describe('noticeShortLine', () => {
  test('Spanish line is exactly the approved one', () => {
    expect(noticeShortLine('es')).toBe(
      'Herramienta de desarrollo: el agente actúa con su sesión en las pestañas conectadas. Ver aviso',
    );
  });

  test('English line is exactly the approved one', () => {
    expect(noticeShortLine('en')).toBe(
      'Development tool: the agent acts with your session on connected tabs. Read notice',
    );
  });

  test('the parts recompose the line, the link being its last words', () => {
    expect(noticeShortLineParts('es').link).toBe('Ver aviso');
    expect(noticeShortLineParts('en').link).toBe('Read notice');
    for (const lang of ['es', 'en'] as const) {
      const { lead, link } = noticeShortLineParts(lang);
      expect(`${lead} ${link}`).toBe(noticeShortLine(lang));
    }
  });
});

describe('noticeFull', () => {
  test('returns the shared notice for each language', () => {
    expect(noticeFull('es')).toEqual(SHARED_NOTICE.es);
    expect(noticeFull('en')).toEqual(SHARED_NOTICE.en);
  });
});

describe('button labels', () => {
  test('acknowledge and close labels per language', () => {
    expect(noticeAcknowledgeLabel('es')).toBe('Entendido');
    expect(noticeAcknowledgeLabel('en')).toBe('I understand');
    expect(noticeCloseLabel('es')).toBe('Cerrar');
    expect(noticeCloseLabel('en')).toBe('Close');
  });
});
