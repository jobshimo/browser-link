// The extension's `SocketFactory` (design 3.1, slice 19): the tab's
// WebSocket to the bridge. The connection code (`app/connection.ts`) speaks
// only `BridgeSocket`, so its tests run on a fake socket.
import type { SocketFactory } from '../app/connection.js';

export const openWebSocket: SocketFactory = (url) => new WebSocket(url);
