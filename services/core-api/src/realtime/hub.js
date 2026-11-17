import { WebSocketServer } from 'ws';

/**
 * WebSocket fan-out. Vitals are coalesced and broadcast at most once per
 * tick so a burst of readings costs one frame per client, not one per reading.
 */
export class RealtimeHub {
  constructor(server, { path = '/ws', tickMs = 1000 } = {}) {
    this.wss = new WebSocketServer({ server, path });
    this.pendingVitals = new Map();
    this.wss.on('connection', (socket) => {
      socket.isAlive = true;
      socket.on('pong', () => (socket.isAlive = true));
      socket.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
    });
    this.tick = setInterval(() => this.flushVitals(), tickMs);
    this.heartbeat = setInterval(() => {
      for (const s of this.wss.clients) {
        if (!s.isAlive) {
          s.terminate();
          continue;
        }
        s.isAlive = false;
        s.ping();
      }
    }, 30_000);
  }

  get clientCount() {
    return this.wss.clients.size;
  }

  broadcast(type, data) {
    if (this.wss.clients.size === 0) return;
    const frame = JSON.stringify({ type, data });
    for (const s of this.wss.clients) if (s.readyState === 1) s.send(frame);
  }

  queueVitals(reading) {
    // Keep only the newest reading per patient for the next frame.
    this.pendingVitals.set(reading.patient_id, reading);
  }

  flushVitals() {
    if (this.pendingVitals.size === 0) return;
    const batch = [...this.pendingVitals.values()];
    this.pendingVitals.clear();
    this.broadcast('vitals', batch);
  }

  close() {
    clearInterval(this.tick);
    clearInterval(this.heartbeat);
    this.wss.close();
  }
}
