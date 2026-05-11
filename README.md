# browser-link

Puente entre un cliente MCP (por ejemplo Claude Code) y una pestaña activa de Chrome, controlado mediante una extensión que el usuario habilita manualmente por tab.

## Qué resuelve

Cuando un agente LLM trabaja sobre una aplicación web, lo habitual es que diagnostique a ciegas: lee el código, intenta razonar sobre el bug, pero no ve lo que realmente ocurre en el navegador. `browser-link` cierra esa brecha sin obligar al usuario a ceder el control de su sesión.

Casos de uso típicos:

- Reproducir un bug reportado en un ticket y verificar que existe.
- Comprobar, una vez aplicada una solución, que el problema quedó resuelto.
- Dar al agente contexto real (DOM, consola, network) sobre lo que sucede en una vista.

## Cómo funciona

```
Cliente MCP (Claude Code)
        │  stdio MCP
        ▼
Servidor MCP local (Node + TypeScript)
        │  WebSocket localhost (127.0.0.1:17529)
        ▼
Extensión Chrome (Manifest V3)
        │  chrome.debugger / Chrome DevTools Protocol
        ▼
Pestaña activa del navegador del usuario
```

- La extensión usa `chrome.debugger` (no mueve el mouse físico). Las acciones se inyectan como eventos sintéticos a nivel de protocolo.
- La activación es manual y por pestaña: el usuario abre el popup de la extensión y hace click en "Conectar" en la pestaña que quiere exponer. Sin activación, el agente no tiene acceso.
- Soporta múltiples pestañas simultáneas. Cada pestaña conectada recibe un ID corto del servidor (`tab_1`, `tab_2`, …).

## Estado

`slice 1` implementado, pendiente de verificación end-to-end en máquina.

- Servidor MCP funcional con dos tools: `browser.list_tabs` y `browser.ping`.
- Extensión MV3 con popup, service worker, conexión WS y attach del debugger.
- Próximos slices: a11y snapshot, console, network, acciones (click/type/scroll), screenshot, inspect.

## Estructura

```
browser-link/
├── package.json              # workspace root (npm workspaces)
├── tsconfig.base.json        # config TypeScript compartida
├── DECISIONS.md              # registro vivo de decisiones de arquitectura
└── packages/
    ├── shared/               # tipos del protocolo WebSocket compartidos
    ├── server/               # servidor MCP + bridge WebSocket
    └── extension/            # extensión Chrome MV3
```

## Scripts disponibles

Todos se ejecutan desde la raíz del repo (`browser-link/`).

| Script | Qué hace |
|---|---|
| `npm install` | Instala dependencias de todos los packages |
| `npm run build` | Buildea server + extension |
| `npm run build:server` | Buildea solo el servidor MCP a `packages/server/dist/` |
| `npm run build:extension` | Buildea solo la extensión a `packages/extension/dist/` (manifest, popup, JS, iconos) |
| `npm run dev` | Alias de `dev:server` |
| `npm run dev:server` | Arranca el servidor MCP en modo watch (recarga al cambiar código) |
| `npm run inspect` | Levanta MCP Inspector apuntando al servidor (UI web para probar tools manualmente) |
| `npm run generate:icons` | Regenera los PNGs de la extensión desde `icons/icon.svg` |
| `npm run typecheck` | Type-check de todos los packages, sin emitir |
| `npm run clean` | Limpia `dist/` de cada package |

## Setup y prueba (slice 1)

### 1. Instalar dependencias

```bash
npm install
```

### 2. Buildear la extensión

```bash
npm run build:extension
```

Genera `packages/extension/dist/` con `manifest.json`, `popup.html`, `popup.js`, `background.js` e `icons/`.

### 3. Cargar la extensión en Chrome

1. Abrir `chrome://extensions/`.
2. Activar "Developer mode" (arriba a la derecha).
3. Click en "Load unpacked".
4. Seleccionar la carpeta `packages/extension/dist`.
5. La extensión aparece en la lista y en la barra de extensiones.

Para ver logs del service worker: en la card de la extensión, click en el link "service worker".

### 4. Arrancar el servidor MCP

En otra terminal:

```bash
npm run dev
```

Esperar a ver `WebSocket listening on ws://127.0.0.1:17529`.

### 5. Conectar una pestaña

1. Abrir cualquier pestaña en Chrome (ej. https://example.com).
2. Click en el ícono de `browser-link` en la barra.
3. Click en "Conectar".
4. Chrome muestra la barra amarilla "DevTools is debugging this tab" — es esperado.
5. El popup muestra el ID de la pestaña asignado por el servidor (`tab_1`).
6. En la terminal del servidor aparece: `Tab registered: tab_1 -> https://example.com`.

### 6. Probar los tools con MCP Inspector

En otra terminal (detené primero el `npm run dev` — Inspector arranca su propia instancia del server):

```bash
npm run inspect
```

Abre la UI web donde podés:
- Listar los tools disponibles.
- Llamar `browser.list_tabs` y ver la pestaña conectada.
- Llamar `browser.ping` con `tab_id: "tab_1"` y recibir `{ title, url }` de la pestaña.

### 7. Probar desde Claude Code

Buildear el servidor:

```bash
npm run build:server
```

Registrarlo en Claude Code:

```bash
claude mcp add browser-link node /Users/martin.bernal/repos/browser-link/packages/server/dist/index.js
```

Las tools `browser.list_tabs` y `browser.ping` quedan disponibles. Cuando la extensión tenga una pestaña conectada, el agente puede usarlas.

## Decisiones de arquitectura

Las decisiones tomadas durante el diseño están registradas en [`DECISIONS.md`](./DECISIONS.md). Ese documento se mantiene vivo y se actualiza con cada decisión nueva.
