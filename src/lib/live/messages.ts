/** Messages exchanged over the daemon's local WebSocket (ws://127.0.0.1:7781). */

export type ConnectionState = 'idle' | 'scanning' | 'connecting' | 'handshaking' | 'streaming' | 'reconnecting' | 'error' | 'stopped';

export interface DaemonStatus {
  state: ConnectionState;
  transport: 'noble' | 'web-bluetooth' | 'simulator';
  device: {
    id: string;
    name: string | null;
    model: string | null;
    serial: string | null;
    firmware: string | null;
    hardware: string | null;
    serviceVariant: string | null;
  } | null;
  batteryPercent: number | null;
  bond: 'passed' | 'failed' | 'not_applicable' | null;
  helloAck: 'opcode' | 'sequence' | 'timeout' | 'not_sent' | null;
  lastPacketAt: number | null;
  packetsThisSession: number;
  reconnectAttempt: number;
  error: string | null;
  lastProcessedAt: number | null;
  commands: Array<{ name: string; label: string; provenance: string; verified: boolean }>;
}

export type ServerMessage =
  | { type: 'status'; status: DaemonStatus }
  | { type: 'hr'; t: number; bpm: number | null; rr: number[]; source: string }
  | { type: 'battery'; t: number; percent: number }
  | { type: 'motion'; t: number; activity: number }
  | {
      type: 'stress';
      t: number;
      score: number | null;
      reason: string;
      hr60: number | null;
      lnRmssd60: number | null;
      rmssd60: number | null;
    }
  | { type: 'packet'; id: number; t: number; uuid: string; hex: string; status: string; length: number }
  | { type: 'command_result'; name: string; ok: boolean; sequence?: number; ack?: string; hex?: string; error?: string }
  | { type: 'processed'; t: number; date: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; t: number };

export type ClientMessage =
  | { type: 'command'; name: string }
  | { type: 'reconnect' }
  | { type: 'recompute' }
  | { type: 'status' };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const value = JSON.parse(raw) as { type?: unknown; name?: unknown };
    switch (value.type) {
      case 'command':
        return typeof value.name === 'string' && value.name.length <= 64 ? { type: 'command', name: value.name } : null;
      case 'reconnect':
      case 'recompute':
      case 'status':
        return { type: value.type };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
