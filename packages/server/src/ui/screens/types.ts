import type { Language } from '../../commands/welcome.js';

/* Every screen is a fully-controlled component: it receives the language and
 * callbacks for navigation, and renders its own content. The App is the
 * single source of truth for `screen` and `language` state. */

export interface CommonProps {
  language: Language;
}
