# Decisiones de arquitectura

Documento vivo. Cada decisión sigue el formato: **Contexto → Decisión → Consecuencias**. Cuando una decisión cambia, se actualiza acá con la fecha del cambio. Las decisiones diferidas se marcan explícitamente para retomar más adelante.

---

## 1. Stack: Node + TypeScript en todo

**Estado:** decidida

**Contexto.** Necesitamos un stack único para servidor MCP y extensión Chrome. El SDK oficial de MCP en TypeScript está más maduro que el de Python y el desarrollador principal trabaja a diario en Angular/NestJS.

**Decisión.** Node + TypeScript en los tres packages (`shared`, `server`, `extension`).

**Consecuencias.** Un solo lenguaje en todo el repo. Los tipos del protocolo WebSocket viven en `packages/shared` y se reutilizan en server y extension sin publicar a npm.

---

## 2. Gestor de paquetes: npm workspaces

**Estado:** decidida

**Contexto.** Tres packages con dependencias entre sí. Alternativas: npm workspaces, pnpm workspaces.

**Decisión.** npm workspaces.

**Consecuencias.** Es el flujo que ya conoce el desarrollador. Para tres packages la ganancia real de pnpm es marginal y no justifica adoptar una tool nueva.

---

## 3. Arquitectura general: extensión + servidor MCP + bridge WebSocket

**Estado:** decidida

**Contexto.** El cliente MCP no puede hablar directamente con Chrome. Hace falta una pieza intermedia que reciba comandos MCP y los traduzca en operaciones sobre una pestaña.

**Decisión.**

```
Cliente MCP <— stdio MCP —> Servidor MCP <— WebSocket localhost —> Extensión Chrome <— CDP —> Tab
```

- El servidor MCP es un proceso Node de vida larga, arrancado por el cliente MCP vía stdio.
- La extensión se conecta al servidor por WebSocket cuando el usuario habilita una pestaña.

**Consecuencias.** Tres componentes con roles bien separados. El servidor es la única pieza que habla MCP. La extensión es la única que toca el navegador.

---

## 4. Activación manual por pestaña

**Estado:** decidida

**Contexto.** La extensión no debe tener acceso a todas las pestañas siempre. El principio es "el usuario abre la puerta de forma explícita".

**Decisión.** La extensión expone un popup con un botón "Conectar" por pestaña. Solo las pestañas explícitamente conectadas son accesibles por el agente. Cerrar la pestaña o tocar "Desconectar" libera inmediatamente `chrome.debugger` y elimina la pestaña del registro.

**Consecuencias.** Principio de mínimo privilegio aplicado correctamente. La extensión nunca está "always-on".

---

## 5. Opera sobre la sesión real de Chrome del usuario

**Estado:** decidida

**Contexto.** Otras herramientas (Playwright MCP, browser-use) lanzan un Chromium aislado. Acá necesitamos la sesión autenticada real del usuario, con sus cookies y su login en la app.

**Decisión.** La extensión se ejecuta en el Chrome del usuario y opera sobre las pestañas reales que él abre.

**Consecuencias.** El agente accede a sesiones autenticadas sin que el usuario tenga que loguearse cada vez. Implica una postura más estricta sobre activación (ver decisión 4) y seguridad (ver decisión 11).

---

## 6. Soporte multi-pestaña con IDs anónimos

**Estado:** decidida

**Contexto.** Algunos casos requieren más de una pestaña conectada simultáneamente (ej. editar en una vista y ver el cambio en otra en tiempo real). Hay que decidir cómo se identifican.

**Decisión.**

- El servidor asigna un ID corto (`tab_1`, `tab_2`, …) a cada pestaña cuando se conecta.
- La extensión muestra ese ID en la pestaña vía overlay no intrusivo, para que el usuario pueda referirse a una pestaña concreta al dar feedback.
- El agente identifica cada pestaña por metadata: ID, URL, título, viewport. Asigna significado mentalmente sin pedir labels al usuario.
- Cada tool call lleva un `tab_id` como parámetro.

**Consecuencias.** El usuario solo abre y conecta; no carga con la tarea de nombrar pestañas. La complejidad de mantener un registro de sesiones la asume el servidor.

---

## 7. Interacciones vía CDP, no mouse físico

**Estado:** decidida

**Contexto.** Mover el cursor real bloquearía al usuario durante la sesión. Despachar eventos vía JavaScript desde un content script tiene gaps de fidelidad (focus, autocompletes nativos, drag&drop).

**Decisión.** La extensión usa `chrome.debugger` para attacharse a la pestaña como debugger CDP. Las acciones se inyectan vía `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. Esto despacha eventos a nivel del motor del navegador, indistinguibles de un click real, sin tocar el cursor físico.

**Consecuencias.** Fidelidad alta, cursor libre. Chrome muestra una barra amarilla "DevTools is debugging this tab" mientras la extensión está activa: lo aceptamos como feature de transparencia (el usuario ve qué pestaña está intervenida).

---

## 8. Representación del DOM: híbrida (a11y tree + inspect on-demand)

**Estado:** decidida

**Contexto.** Tres opciones: HTML crudo (caro, frágil), accessibility tree (eficiente, semántico), o híbrido.

**Decisión.** A11y tree como representación por defecto. Cada elemento recibe un `ref` numérico estable durante la sesión. Las acciones (click, type, scroll, hover) apuntan a `ref`, no a CSS selectors. Para casos en que el agente necesita HTML crudo o estilos computados de un elemento puntual, expone un tool `browser.inspect(ref)` on-demand.

**Consecuencias.** Bajo costo de tokens por snapshot. Repros más estables ante cambios de clases CSS. Forzar el pensamiento en términos de a11y tree puede revelar problemas de accesibilidad reales como efecto colateral.

---

## 9. Catálogo de tools del MVP

**Estado:** alcance decidido. Slice 1 (`browser.list_tabs` + `browser.ping`) implementado, pendiente verificación end-to-end. Resto pendiente.

**Contexto.** Necesitamos un set mínimo viable que permita reproducir un ticket completo y verificar un fix.

**Tools comprometidos para el MVP:**

| Tool                 | Categoría | Propósito                                     |
| -------------------- | --------- | --------------------------------------------- |
| `browser.list_tabs`  | Read      | Listar pestañas conectadas (ID, URL, título)  |
| `browser.snapshot`   | Read      | Devolver a11y tree de la pestaña con refs     |
| `browser.inspect`    | Read      | HTML crudo + estilos computados de un ref     |
| `browser.console`    | Read      | Logs/errors/warnings acumulados               |
| `browser.network`    | Read      | Requests/responses con status, headers y body |
| `browser.screenshot` | Read      | Captura de la pestaña                         |
| `browser.click`      | Action    | Click sobre un ref                            |
| `browser.type`       | Action    | Escribir texto en un ref                      |
| `browser.scroll`     | Action    | Scroll en pestaña o elemento                  |
| `browser.navigate`   | Action    | Navegar a una URL                             |
| `browser.wait_for`   | Sync      | Esperar a un selector/ref o tiempo            |

**Slice 1 (rebanada thin end-to-end):** solo `browser.ping(tab_id) → { title }`. Valida el bridge completo sin meter complejidad de tools reales.

---

## 10. Workflow de desarrollo: MCP Inspector

**Estado:** decidida

**Contexto.** Probar tools enchufando el servidor a Claude Code en cada iteración es lento.

**Decisión.** Durante el desarrollo, validamos tools con [MCP Inspector](https://github.com/modelcontextprotocol/inspector). Solo cuando un tool está estable lo probamos vía cliente MCP real.

**Consecuencias.** Loop de iteración rápido. El servidor MCP debe ser invocable independientemente.

---

## 11. Seguridad: process binding por el kernel del SO

**Estado:** decidida

**Contexto.** El servidor MCP escucha en `127.0.0.1:17529`. Loopback ya impide conexiones desde fuera de la máquina, pero cualquier proceso local que corra como el mismo usuario podría conectarse y hacerse pasar por la extensión Chrome.

**Modelo de amenaza realista:** el atacante NO está ya dentro de Chrome (si lo estuviera, tiene acceso directo a las pestañas y no necesita browser-link). El atacante es un proceso local random — malware no-targeted, un script de otra herramienta mal configurada, un escaneador. Queremos cerrar ese vector sin pedirle al usuario ningún paso manual.

**Opciones evaluadas y descartadas:**

- **Native Messaging:** patrón oficial de Chrome. Requiere registrar un manifest en una ruta del SO con el extension ID autorizado. El ID cambia entre "Load unpacked" y publicación en el Chrome Web Store; obligaría a re-instalar el manifest tras cada cambio. Acopla el proyecto a Google y agrega ~300 líneas + un installer por OS. Rechazado: queremos no depender de Google.
- **Token de pairing one-shot:** el server genera un token, el usuario lo copia y lo pega en el popup de la extensión. Falla bajo el modelo de amenaza: cualquier proceso que corre como el mismo usuario puede leer el token del disco (perms 0600 protegen contra otros UIDs, no contra malware tuyo). Y agrega fricción visible.

**Decisión.** El servidor valida el peer de cada handshake WebSocket consultando al kernel quién abrió la conexión TCP entrante.

- **macOS / Linux:** `lsof -nP -F pc -iTCP@host:port -sTCP:ESTABLISHED` devuelve PID + command name del proceso al otro extremo del socket. Output con campos prefijados sobrevive nombres con espacios (típico en macOS: `Google Chrome Helper`).
- **Windows:** `netstat -ano` correlaciona host:port → PID. `tasklist /FI "PID eq <pid>" /FO CSV /NH` traduce PID → image name.

El nombre del binario se compara contra una allowlist per-OS de binarios Chromium-based (`packages/server/src/auth/allowlist.ts`): Chrome, Chromium, Edge, Brave, Vivaldi (más sus procesos helper en macOS, donde la stack de red vive en `Google Chrome Helper`). Match estricto, case-sensitive, sin path.

Si el lookup falla o el peer no está en la allowlist, el upgrade se rechaza con HTTP 403 antes de intercambiar bytes de aplicación.

**Consecuencias.**

- Cero acción del usuario: instalar la extensión + click "Conectar" sigue siendo el único setup.
- Cierra "cualquier proceso local random" como vector de ataque.
- NO cierra "malware ya inyectado dentro de Chrome" (chrome.debugger desde otra extensión maliciosa, dylib injection). Eso está fuera del scope de un bridge userspace y queda documentado en el About / README.
- Si en el futuro alguien usa un browser custom (un fork con otro binary name), tiene que añadirlo a la allowlist a mano. El `doctor` muestra la allowlist activa por OS para que sea obvio cuando algo no está pasando.

---

## 12. Distribución: solo local en MVP

**Estado:** decidida (provisional)

**Decisión.** Mientras el proyecto esté en desarrollo, la extensión se carga unpacked vía `chrome://extensions/` → Developer mode → Load unpacked. Subir a Chrome Web Store queda para una fase posterior, una vez resuelta la decisión 11.

---

## Pendientes (a abordar cuando toque)

- **Captura de network:** alcance exacto. ¿Capturamos bodies completos siempre, o solo metadata + body on-demand? Sensibilidad de datos (tokens, PII) a tener en cuenta.
- **Manejo de navegación dentro de la pestaña:** si la pestaña hace un full refresh o redirect, `chrome.debugger` puede desadjuntarse. Estrategia de reattach.
- **Persistencia de configuración:** ¿la extensión recuerda algo entre sesiones? Probablemente no, pero documentarlo.
- **Manejo de fallos de acciones:** retry, snapshot-antes-de-actuar, timeouts.
