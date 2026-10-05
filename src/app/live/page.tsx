import { BluetoothButton, LinkBadge, LiveView } from '@/components/live/live-view';
import { PageHeader } from '@/components/ui';
import { latestBaselines, today } from '@/lib/queries';
import { getDb } from '@/lib/storage/db';
import { effectiveMaxHr, getSettings } from '@/lib/storage/settings';

export const dynamic = 'force-dynamic';

export default function LivePage() {
  const db = getDb();
  const settings = getSettings(db);
  const baselines = latestBaselines(db, today(db));
  const rhr = baselines.restingHr?.mean ?? 60;
  const reference = {
    restingHr: rhr,
    maxHr: effectiveMaxHr(settings.profile),
    dayRestHr: rhr + 15,
    dayLnRmssd: baselines.lnRmssd ? baselines.lnRmssd.mean - 0.6 : Math.log(30),
    dayLnRmssdSd: 0.3,
  };
  return (
    <>
      <PageHeader title="Live" subtitle="Streaming from the strap through the local daemon or Web Bluetooth">
        <LinkBadge />
        <BluetoothButton reference={reference} />
      </PageHeader>
      <LiveView port={settings.daemon.wsPort} timeZone={settings.timeZone} />
    </>
  );
}
