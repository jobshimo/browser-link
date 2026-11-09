/**
 * Verbatim copy of `packages/shared/src/notice.ts` (everything below this
 * header). The server publishes to npm standalone and cannot import
 * `@browser-link/shared`; `notice.test.ts` fails the build if the two
 * copies drift. Change both together.
 */

export interface NoticeText {
  title: string;
  paragraphs: string[];
}

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
