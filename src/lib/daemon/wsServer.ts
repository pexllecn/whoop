/**
 * Local WebSocket for live telemetry. Bound to 127.0.0.1 only, and browser
 * connections are accepted only from the configured dashboard origins, so a
 * random website cannot read biometrics from the daemon.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, type ClientMessage, type ServerMessage } from '../live/messages';

const MAX_BUFFERED_BYTES = 1 << 20;

export class LiveServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  constructor(
    port: number,
    allowedOrigins: string[],
    private readonly onMessage: (message: ClientMessage, reply: (m: ServerMessage) => void) => void,
    private readonly onConnect: (send: (m: ServerMessage) => void) => void,
    host = '127.0.0.1',
  ) {
    const allowed = new Set(allowedOrigins);
    this.wss = new WebSocketServer({
      host,
      port,
      maxPayload: 16 * 1024,
      verifyClient: ({ origin }: { origin?: string }) => origin === undefined || origin === '' || allowed.has(origin),
    });
    this.wss.on('connection', (socket) => {
      this.clients.add(socket);
      const send = (m: ServerMessage) => this.sendTo(socket, m);
      socket.on('message', (data) => {
        const message = parseClientMessage(data.toString());
        if (message) this.onMessage(message, send);
      });
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
      this.onConnect(send);
    });
  }

  get port(): number {
    const address = this.wss.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.wss.address()) return resolve();
      this.wss.once('listening', () => resolve());
      this.wss.once('error', reject);
    });
  }

  private sendTo(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    socket.send(JSON.stringify(message));
  }

  broadcast(message: ServerMessage): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(message);
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN && socket.bufferedAmount <= MAX_BUFFERED_BYTES) socket.send(payload);
    }
  }

  close(): Promise<void> {
    for (const socket of this.clients) socket.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
