import { CableRejectedError, type Connect, type WebSocketLike } from "../cable/socket.js";

/**
 * Opens Sabha's socket from a Worker or Durable Object. `new WebSocket()` can't send headers,
 * and Sabha takes the key only as a header, so this uses the fetch Upgrade form, which does.
 */
export const connectWorkers: Connect = async (url, { headers, protocol, signal }) => {
  const response = await fetch(url.replace(/^ws/, "http"), {
    headers: { ...headers, Upgrade: "websocket", "Sec-WebSocket-Protocol": protocol },
    // A redirect would carry the key elsewhere; Sabha's socket never redirects.
    redirect: "manual",
    ...(signal ? { signal } : {}),
  });
  const socket = response.webSocket;
  if (!socket) {
    if (response.status === 401 || response.status === 403) throw new CableRejectedError(`HTTP ${response.status}`);
    throw new Error(`the socket handshake answered HTTP ${response.status}`);
  }
  socket.accept();
  return socket as unknown as WebSocketLike;
};
