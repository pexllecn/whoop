'use client';

/**
 * Browser-side live telemetry store, fed by either
 *   - the daemon's local WebSocket (ws://127.0.0.1:<port>), or
 *   - a direct Web Bluetooth connection, decoded in the browser with the same
 *     protocol code as the daemon; raw packets are forwarded to /api/ingest
 *     so they are stored (raw-first) exactly like daemon captures.
 * Components read it with useSyncExternalStore; updates are batched per frame.
 */
import { useSyncExternalStore } from 'react';
import { BleSession } from '@/lib/ble/session';
import { WebBluetoothTransport } from '@/lib/ble/webBluetoothTransport';
import type { DaemonStatus, ServerMessage } from '@/lib/live/messages';
import { LiveStressMonitor } from '@/lib/daemon/liveStress';
import { BUILTIN_COMMANDS } from '@/lib/protocol/commands';
import { PROPRIETARY_SERVICES, SIG } from '@/lib/protocol/constants';
import { bytesToHex } from '@/lib/protocol/bytes';
import { PacketDecoder } from '@/lib/protocol/decoder';
import { BeatClock } from '@/lib/physiology/epochs';
import type { StressReference } from '@/lib/physiology/stressMonitor';

export interface PacketLine {
  id: number;
  t: number;
  uuid: string;
  hex: string;
  status: string;
  length: number;
}

export interface StressSample {
  t: number;
  score: number | null;
  reason: string;
  rmssd60: number | null;
  hr60: number | null;
}

export interface LiveSnapshot {
  link: 'disconnected' | 'connecting' | 'daemon' | 'web-bluetooth';
  linkError: string | null;
  status: DaemonStatus | null;
  hr: Array<{ t: number; bpm: number }>;
  beats: Array<{ t: number; rr: number }>;
  stress: StressSample[];
  motion: Array<{ t: number; activity: number }>;
  packets: PacketLine[];
  battery: number | null;
  log: Array<{ t: number; level: string; message: string }>;
  lastCommand: Extract<ServerMessage, { type: 'command_result' }> | null;
}

const HR_KEEP = 10 * 60_000;
const BEAT_KEEP = 3 * 60_000;
const STRESS_KEEP = 60 * 60_000;

const INITIAL: LiveSnapshot = {
  link: 'disconnected',
  linkError: null,
  status: null,
  hr: [],
  beats: [],
  stress: [],
  motion: [],
  packets: [],
  battery: null,
  log: [],
  lastCommand: null,
};

class LiveStore {
  private state: LiveSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  private frame: number | null = null;
  private socket: WebSocket | null = null;
  private socketPort: number | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private clock = new BeatClock();
  private bluetooth: { session: BleSession; transport: WebBluetoothTransport; timers: ReturnType<typeof setInterval>[] } | null = null;
  private pendingCommand: ((m: ServerMessage) => void) | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  getServerSnapshot = () => INITIAL;

  private set(patch: Partial<LiveSnapshot> | ((s: LiveSnapshot) => Partial<LiveSnapshot>)) {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    if (this.frame === null) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        for (const l of this.listeners) l();
      });
    }
  }

  // ------------------------------------------------------------ daemon
  connectDaemon(port: number) {
    if (this.bluetooth) return;
    if (this.socket && this.socketPort === port && this.socket.readyState <= WebSocket.OPEN) return;
    this.socketPort = port;
    this.set({ link: 'connecting', linkError: null });
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.set({ link: 'daemon', linkError: null });
    };
    socket.onmessage = (e) => {
      try {
        this.handle(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.bluetooth) return;
      this.set({ link: 'disconnected', linkError: 'Daemon not reachable. Start it with `npm run daemon` (or `npm run daemon:simulate`).' });
      const delay = Math.min(15_000, 1000 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connectDaemon(port), delay);
    };
  }

  private send(message: object) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendCommand(name: string): Promise<ServerMessage> {
    if (this.bluetooth) {
      const definition = Object.values(BUILTIN_COMMANDS).find((c) => c.name === name);
      if (!definition) return Promise.resolve({ type: 'command_result', name, ok: false, error: 'Unknown command' });
      return this.bluetooth.session
        .sendCommand(definition)
        .then((r) => {
          const result: ServerMessage = { type: 'command_result', name, ok: true, sequence: r.sequence, ack: r.ack, hex: r.hex };
          this.set({ lastCommand: result });
          return result;
        })
        .catch((error: unknown) => ({ type: 'command_result', name, ok: false, error: error instanceof Error ? error.message : String(error) }) as ServerMessage);
    }
    return new Promise((resolve) => {
      this.pendingCommand = resolve;
      this.send({ type: 'command', name });
      setTimeout(() => {
        if (this.pendingCommand === resolve) {
          this.pendingCommand = null;
          resolve({ type: 'command_result', name, ok: false, error: 'No response from daemon' });
        }
      }, 6000);
    });
  }

  reconnectStrap() {
    this.send({ type: 'reconnect' });
  }

  requestProcessing() {
    this.send({ type: 'recompute' });
  }

  private handle(m: ServerMessage) {
    const now = Date.now();
    switch (m.type) {
      case 'status':
        this.set({ status: m.status, battery: m.status.batteryPercent ?? this.state.battery });
        break;
      case 'hr':
        this.addHeartRate(m.t, m.bpm, m.rr, m.source, now);
        break;
      case 'battery':
        this.set({ battery: m.percent });
        break;
      case 'motion':
        this.set((s) => ({ motion: [...s.motion.filter((x) => x.t > now - HR_KEEP), { t: m.t, activity: m.activity }] }));
        break;
      case 'stress':
        this.set((s) => ({ stress: [...s.stress.filter((x) => x.t > now - STRESS_KEEP), { t: m.t, score: m.score, reason: m.reason, rmssd60: m.rmssd60, hr60: m.hr60 }] }));
        break;
      case 'packet':
        this.set((s) => ({ packets: [m, ...s.packets].slice(0, 80) }));
        break;
      case 'command_result':
        this.set({ lastCommand: m });
        this.pendingCommand?.(m);
        this.pendingCommand = null;
        break;
      case 'log':
        this.set((s) => ({ log: [{ t: m.t, level: m.level, message: m.message }, ...s.log].slice(0, 40) }));
        break;
      case 'backlog': {
        this.clock.reset();
        const hr: LiveSnapshot['hr'] = [];
        const beats: LiveSnapshot['beats'] = [];
        for (const h of m.hr) {
          if (h.bpm !== null) hr.push({ t: h.t, bpm: h.bpm });
          beats.push(...this.clock.push(h.t, h.rr, h.source));
        }
        this.set({
          hr: hr.filter((x) => x.t > now - HR_KEEP),
          beats: beats.filter((b) => b.t > now - BEAT_KEEP),
          stress: m.stress.map((x) => ({ t: x.t, score: x.score, reason: x.reason, rmssd60: x.rmssd60, hr60: x.hr60 })),
          packets: m.packets,
        });
        break;
      }
      case 'processed':
        this.set((s) => ({ log: [{ t: m.t, level: 'info', message: `Rescored ${m.date}` }, ...s.log].slice(0, 40) }));
        break;
    }
  }

  private addHeartRate(t: number, bpm: number | null, rr: number[], source: string, now: number) {
    const beats = this.clock.push(t, rr, source);
    this.set((s) => ({
      hr: bpm === null ? s.hr : [...s.hr.filter((x) => x.t > now - HR_KEEP), { t, bpm }],
      beats: [...s.beats.filter((b) => b.t > now - BEAT_KEEP), ...beats],
    }));
  }

  // ------------------------------------------------------ Web Bluetooth
  async connectBluetooth(reference: StressReference) {
    if (this.bluetooth) return;
    this.socket?.close();
    this.socket = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.set({ link: 'connecting', linkError: null });
    const transport = new WebBluetoothTransport();
    try {
      const [device] = await transport.scan({ serviceUuids: [...PROPRIETARY_SERVICES.map((s) => s.uuid), SIG.HEART_RATE_SERVICE], timeoutMs: 0 });
      if (!device) throw new Error('No device chosen');
      const connection = await transport.connect(device.id);
      const decoder = new PacketDecoder();
      const stress = new LiveStressMonitor(reference);
      let queue: Array<{ uuid: string; hex: string; t: number }> = [];
      let first = true;
      let packetId = 0;
      const flush = async () => {
        if (!queue.length) return;
        const packets = queue;
        queue = [];
        try {
          await fetch('/api/ingest', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId: device.id, reset: first, packets }),
          });
          first = false;
        } catch {
          queue = packets.concat(queue).slice(-20_000); // keep and retry; nothing is dropped silently
        }
      };
      const session = new BleSession(connection, {
        onNotification: (n) => {
          queue.push({ uuid: n.characteristicUuid, hex: bytesToHex(n.bytes), t: n.receivedAt });
          const outcome = decoder.decode(n.characteristicUuid, n.bytes, n.receivedAt);
          const now = Date.now();
          this.set((s) => ({ packets: [{ id: ++packetId, t: n.receivedAt, uuid: n.characteristicUuid, hex: bytesToHex(n.bytes.subarray(0, 48)), status: outcome.status, length: n.bytes.length }, ...s.packets].slice(0, 80) }));
          for (const event of outcome.events) {
            if (event.type === 'heart_rate') {
              stress.addHeartRate(event.at, event.bpm, event.rrMs, event.source);
              this.addHeartRate(event.at, event.bpm, event.rrMs, event.source, now);
            } else if (event.type === 'battery') this.set({ battery: event.percent });
          }
        },
        onLog: (level, message) => this.set((s) => ({ log: [{ t: Date.now(), level, message }, ...s.log].slice(0, 40) })),
      });
      const info = await session.start();
      const timers = [
        setInterval(() => void flush(), 1000),
        setInterval(() => {
          const r = stress.score(Date.now());
          this.set((s) => ({ stress: [...s.stress.filter((x) => x.t > Date.now() - STRESS_KEEP), { t: Date.now(), score: r.score, reason: r.reason, rmssd60: r.rmssd60, hr60: r.hr60 }] }));
        }, 5000),
      ];
      connection.onDisconnect(() => {
        for (const timer of timers) clearInterval(timer);
        void flush();
        this.bluetooth = null;
        this.set({ link: 'disconnected', linkError: 'Strap disconnected' });
      });
      this.bluetooth = { session, transport, timers };
      this.set({
        link: 'web-bluetooth',
        battery: info.batteryPercent,
        status: {
          state: 'streaming',
          transport: 'web-bluetooth',
          device: { id: info.deviceId, name: info.deviceName, ...info.deviceInfo, serviceVariant: info.serviceVariant },
          batteryPercent: info.batteryPercent,
          bond: info.bond,
          helloAck: info.helloAck,
          lastPacketAt: null,
          packetsThisSession: 0,
          reconnectAttempt: 0,
          error: null,
          lastProcessedAt: null,
          commands: Object.values(BUILTIN_COMMANDS).map((c) => ({ name: c.name, label: c.label, provenance: c.provenance, verified: c.verified })),
        },
      });
    } catch (error) {
      await transport.close().catch(() => undefined);
      this.set({ link: 'disconnected', linkError: error instanceof Error ? error.message : String(error) });
    }
  }

  async disconnectBluetooth() {
    if (!this.bluetooth) return;
    const { session, timers } = this.bluetooth;
    for (const timer of timers) clearInterval(timer);
    await session.stop().catch(() => undefined);
    this.bluetooth = null;
    this.set({ link: 'disconnected' });
  }
}

export const liveStore = new LiveStore();

export function useLive(): LiveSnapshot {
  return useSyncExternalStore(liveStore.subscribe, liveStore.getSnapshot, liveStore.getServerSnapshot);
}
