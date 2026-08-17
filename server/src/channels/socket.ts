import { createBunWebSocket } from "hono/bun";

/**
 * The one WebSocket adapter for the process.
 *
 * `createBunWebSocket` pairs a route-side `upgradeWebSocket` with a server-side `websocket` handler,
 * and the two halves have to come from the same call. Bun is given the handler once, when the
 * server starts, and it has to be the one the routes upgraded through. Calling it per route would
 * upgrade connections into a handler nothing is listening on.
 */
const { upgradeWebSocket, websocket } = createBunWebSocket();

export { upgradeWebSocket, websocket };
