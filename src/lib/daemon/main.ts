/**
 * OpenPulse BLE daemon.
 *
 *   npm run daemon                 connect to a real strap via noble
 *   npm run daemon:simulate        stream from the built-in simulator
 *   options: --simulate --db <path> --port <ws port> --device <peripheral id>
 *            --name <advertised name filter> --no-process
 *
 * The daemon never opens a connection to anything except the strap and
 * 127.0.0.1 (its own WebSocket for the dashboard).
 */
import { BleDaemon } from './bleDaemon';
import { LiveServer } from './wsServer';
import { NobleTransport } from '../ble/nobleTransport';
import { SimulatorTransport } from '../ble/simulatorTransport';
import { openDatabase, resolveDbPath } from '../storage/db';
import { getSettings } from '../storage/settings';

export interface DaemonArgs {
  simulate: boolean;
  db: string | null;
  port: number | null;
  device: string | null;
  name: string | null;
  process: boolean;
}

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith('--') ? argv[index + 1]! : null;
  };
  const port = value('--port');
  return {
    simulate: argv.includes('--simulate') || process.env.OPENPULSE_SIMULATE === '1',
    db: value('--db'),
    port: port ? Number(port) : null,
    device: value('--device'),
    name: value('--name'),
    process: !argv.includes('--no-process'),
  };
}

async function main(): Promise<void> {
  const args = parseDaemonArgs(process.argv.slice(2));
  if (args.db) process.env.OPENPULSE_DB = args.db;
  const db = openDatabase();
  const settings = getSettings(db);
  if (args.device) settings.daemon.deviceId = args.device;
  if (args.name) settings.daemon.nameFilter = args.name;

  const log = (level: string, message: string) => console.log(`${new Date().toISOString()} [${level}] ${message}`);
  const transport = args.simulate ? new SimulatorTransport({ timeZone: settings.timeZone }) : new NobleTransport();
  const daemon = new BleDaemon({ db, transport, settings, autoProcess: args.process, log });
  const port = args.port ?? settings.daemon.wsPort;
  const live = new LiveServer(
    port,
    settings.daemon.allowedOrigins,
    (message, reply) => {
      if (message.type === 'command') void daemon.sendCommand(message.name).then(reply);
      else if (message.type === 'reconnect') daemon.requestReconnect();
      else if (message.type === 'recompute') daemon.processNow();
      else reply({ type: 'status', status: daemon.status() });
    },
    (send) => send({ type: 'status', status: daemon.status() }),
  );
  await live.ready();
  daemon.setBroadcaster(live);
  log('info', `OpenPulse daemon (${transport.kind}) | db ${resolveDbPath()} | live ws://127.0.0.1:${live.port}`);
  daemon.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `${signal} received, shutting down`);
    await daemon.stop();
    await live.close();
    db.$client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('main.ts') || entry.endsWith('daemon.mjs')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
