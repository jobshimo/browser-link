/**
 * Pure decision and text-selection logic for the product notice in the
 * popup — no `chrome.*` here, same split as idle-policy.ts and
 * flow-recording-policy.ts (popup.ts owns the storage I/O and the DOM).
 *
 * Language: the popup has no language setting of its own (every other
 * popup string is English), so the notice follows the browser UI
 * language — Spanish when `navigator.language` starts with `es`, English
 * otherwise.
 *
 * Why a copy of `NOTICE` lives here instead of an import: the extension is
 * built with plain `tsc` (no bundler), so a runtime import of
 * `@browser-link/shared` would reach Chrome as an unresolvable bare
 * specifier (background.ts only ever imports TYPES from it). The constant
 * below is a mechanical copy of `packages/shared/src/notice.ts`, and
 * `notice-policy.test.ts` fails the build if it stops being value-identical
 * to the shared source. Change both together.
 */

import type { NoticeText } from '@browser-link/shared';

export type NoticeLanguage = 'es' | 'en';

/** `chrome.storage.local` key set to `true` once the user confirmed the
 * full notice before their first Connect on this browser profile. */
export const NOTICE_ACKNOWLEDGED_STORAGE_KEY = 'noticeAcknowledged';

export const NOTICE: { es: NoticeText; en: NoticeText } = {
  es: {
    title: 'Aviso importante',
    paragraphs: [
      'browser-link es una herramienta de desarrollo. Conecta un agente de IA a las pestañas de Chrome que usted elija, y en ellas el agente actúa con su propia sesión: ve y puede usar todo lo que el navegador tenga en esas pestañas, incluidos inicios de sesión activos, cookies y tokens, contraseñas y tarjetas de pago autocompletadas, correos, documentos y cualquier dato que la página muestre o permita enviar. Puede hacer clic, escribir, enviar formularios y descargar archivos como lo haría usted.',
      'Conecte únicamente pestañas que un agente deba manejar, desconéctelas al terminar y no la utilice en sitios cuyos términos lo prohíban ni con datos que no pueda permitirse exponer. La decisión de a qué dar acceso, y lo que el agente haga con ese acceso, es responsabilidad exclusiva del usuario.',
      'El software se distribuye "tal cual", sin garantía de ningún tipo, bajo licencia MIT. Los autores no se hacen responsables de pérdidas, daños o usos indebidos derivados de su utilización.',
    ],
  },
  en: {
    title: 'Important notice',
    paragraphs: [
      'browser-link is a development tool. It connects an AI agent to the Chrome tabs you choose, and in those tabs the agent acts with your own session: it sees and can use everything the browser holds in them, including active logins, cookies and tokens, autofilled passwords and payment cards, email, documents and any data the page shows or lets you submit. It can click, type, submit forms and download files as you would.',
      "Connect only tabs an agent should operate, disconnect them when you are done, and do not use it on sites whose terms forbid it or with data you cannot afford to expose. Deciding what to grant access to, and what the agent does with that access, is solely the user's responsibility.",
      'The software is provided "as is", without warranty of any kind, under the MIT license. The authors accept no liability for losses, damage or misuse arising from its use.',
    ],
  },
};

/** Spanish when the browser language starts with `es`, English otherwise
 * (including when the language is unavailable). */
export function noticeLanguage(navLang: string | undefined): NoticeLanguage {
  return navLang?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** The full notice must be confirmed before Connect unless the stored
 * acknowledgement is the literal `true` — any other value (missing,
 * corrupted) shows it again rather than failing open. */
export function shouldShowNoticeBeforeConnect(stored: unknown): boolean {
  return stored !== true;
}

const SHORT_LINE: Record<NoticeLanguage, { lead: string; link: string }> = {
  es: {
    lead: 'Herramienta de desarrollo: el agente actúa con su sesión en las pestañas conectadas.',
    link: 'Ver aviso',
  },
  en: {
    lead: 'Development tool: the agent acts with your session on connected tabs.',
    link: 'Read notice',
  },
};

/** The bottom line split for rendering: `lead` as text, `link` as the
 * control that opens the full notice. */
export function noticeShortLineParts(lang: NoticeLanguage): { lead: string; link: string } {
  return SHORT_LINE[lang];
}

/** The popup's one-line notice, link words included. */
export function noticeShortLine(lang: NoticeLanguage): string {
  const { lead, link } = SHORT_LINE[lang];
  return `${lead} ${link}`;
}

/** The full notice (title + paragraphs) in `lang`. */
export function noticeFull(lang: NoticeLanguage): NoticeText {
  return NOTICE[lang];
}

/** Label of the confirmation button shown before the first Connect. */
export function noticeAcknowledgeLabel(lang: NoticeLanguage): string {
  return lang === 'es' ? 'Entendido' : 'I understand';
}

/** Label of the control that closes the notice opened from the bottom line. */
export function noticeCloseLabel(lang: NoticeLanguage): string {
  return lang === 'es' ? 'Cerrar' : 'Close';
}
