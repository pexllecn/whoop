import { DeviceLivePanel, MaintenanceActions } from '@/components/device-panel';
import { Card, PageHeader } from '@/components/ui';
import { fmt, fmtRelative } from '@/lib/format';
import { PARSER_VERSION } from '@/lib/protocol/constants';
import { deviceView, latestBaselines, today } from '@/lib/queries';
import { getDb } from '@/lib/storage/db';
import { effectiveMaxHr, getSettings } from '@/lib/storage/settings';

export const dynamic = 'force-dynamic';

const STATUS_HELP: Record<string, string> = {
  decoded: 'fully decoded',
  partial: 'some frames unmapped or invalid',
  fragment: 'part of a frame completed later',
  unsynced: 'bytes outside any frame',
  unmapped: 'valid frame, layout not mapped yet',
  crc_error: 'failed CRC validation',
  malformed: 'standard value off-spec',
  ignored: 'characteristic not handled',
  error: 'decoder error (replayable)',
  pending: 'not decoded yet',
};

export default function DevicePage() {
  const db = getDb();
  const view = deviceView(db);
  const settings = getSettings(db);
  const baselines = latestBaselines(db, today(db));
  const rhr = baselines.restingHr?.mean ?? 60;
  const reference = { restingHr: rhr, maxHr: effectiveMaxHr(settings.profile), dayRestHr: rhr + 15, dayLnRmssd: baselines.lnRmssd ? baselines.lnRmssd.mean - 0.6 : Math.log(30), dayLnRmssdSd: 0.3 };

  return (
    <>
      <PageHeader title="Device" subtitle="BLE link, commands, raw packets and decoding" />
      <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
        <DeviceLivePanel port={settings.daemon.wsPort} timeZone={settings.timeZone} reference={reference} />
        <div className="grid content-start gap-4">
          <Card title="Raw packet store" subtitle={`Parser version ${PARSER_VERSION}. Raw bytes are kept so new byte mappings can be replayed over history.`}>
            <div className="text-3xl font-semibold">{fmt(view.total)}</div>
            <div className="text-xs text-muted">raw packets stored</div>
            <ul className="mt-3 space-y-1 text-sm">
              {Object.entries(view.statuses)
                .sort((a, b) => b[1] - a[1])
                .map(([status, n]) => (
                  <li key={status} className="flex justify-between gap-3">
                    <span className="text-ink-2">
                      {status} <span className="text-xs text-muted">· {STATUS_HELP[status] ?? ''}</span>
                    </span>
                    <span className="tabular">{fmt(n)}</span>
                  </li>
                ))}
            </ul>
            <div className="mt-4">
              <MaintenanceActions stale={view.stale} />
            </div>
          </Card>
          <Card title="Known devices">
            {view.devices.length === 0 ? (
              <p className="text-sm text-muted">None yet.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {view.devices.map((d) => (
                  <li key={d.id}>
                    <div className="text-ink">{d.name ?? d.id}</div>
                    <div className="text-xs text-muted">
                      {d.transport} · {d.model ?? 'model ?'} · fw {d.firmware ?? '?'} · hw {d.hardware ?? '?'} · battery {d.batteryPct ?? '?'}% · seen {fmtRelative(d.lastSeenAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Protocol map" subtitle="Add commands you discover in your own captures">
            <p className="text-xs text-ink-2">
              Put a JSON file at <code>data/protocol-map.json</code> and restart the daemon:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-raised p-3 text-[11px] text-ink-2">{`{
  "commands": [
    { "name": "haptic", "label": "Haptic buzz",
      "opcode": "0x??", "args": "01" }
  ]
}`}</pre>
          </Card>
        </div>
      </div>
    </>
  );
}
