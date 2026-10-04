import { ZoneBars } from '@/components/charts/zone-bars';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { SOURCE_LABEL, fmt, fmtClock, fmtDate, fmtDuration } from '@/lib/format';
import { today, workoutsBetween } from '@/lib/queries';
import { getDb } from '@/lib/storage/db';
import { getSettings } from '@/lib/storage/settings';
import { addDays } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function WorkoutsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const db = getDb();
  const settings = getSettings(db);
  const params = await searchParams;
  const days = [7, 30, 90].includes(Number(params.days)) ? Number(params.days) : 30;
  const end = today(db);
  const list = workoutsBetween(db, addDays(end, -(days - 1)), end);
  const zones = [0, 1, 2, 3, 4, 5].map((z) => list.reduce((sum, w) => sum + ((w[`zone${z}Ms` as 'zone0Ms'] as number | null) ?? 0), 0));
  const totalStrain = list.filter((w) => w.source === 'openpulse').reduce((s, w) => s + (w.strain ?? 0), 0);

  return (
    <>
      <PageHeader title="Workouts" subtitle="Detected from sustained effort ≥ 40 % of heart-rate reserve, plus imported sessions">
        {[7, 30, 90].map((d) => (
          <a key={d} href={`/workouts?days=${d}`} aria-current={d === days ? 'true' : undefined} className={`rounded-lg border px-3 py-1.5 text-sm ${d === days ? 'border-accent text-ink' : 'border-hair text-ink-2 hover:bg-card'}`}>
            {d} days
          </a>
        ))}
      </PageHeader>

      {list.length === 0 ? (
        <EmptyState title="No workouts in this period" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <Card title={`${list.length} sessions`}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Day</th>
                    <th className="py-2 pr-3 font-medium">Activity</th>
                    <th className="py-2 pr-3 font-medium">Duration</th>
                    <th className="py-2 pr-3 text-right font-medium">Strain</th>
                    <th className="py-2 pr-3 text-right font-medium">Avg / max HR</th>
                    <th className="py-2 pr-3 text-right font-medium">kcal</th>
                    <th className="py-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {list.map((w) => (
                    <tr key={w.id} className="border-t border-hair">
                      <td className="py-2 pr-3 text-ink-2">
                        {fmtDate(w.date, 'short')} {fmtClock(w.startTs, settings.timeZone)}
                      </td>
                      <td className="py-2 pr-3">{w.sport}</td>
                      <td className="py-2 pr-3">{fmtDuration(w.endTs - w.startTs)}</td>
                      <td className="py-2 pr-3 text-right">{fmt(w.strain, 1)}</td>
                      <td className="py-2 pr-3 text-right">
                        {fmt(w.avgHr, 0)} / {fmt(w.maxHr, 0)}
                      </td>
                      <td className="py-2 pr-3 text-right">{fmt(w.kcal, 0)}</td>
                      <td className="py-2">
                        <Badge>{SOURCE_LABEL[w.source] ?? w.source}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="grid content-start gap-4">
            <Card title="Time in zones" subtitle="% of heart-rate reserve, all sessions with zone data">
              <ZoneBars zoneMs={zones} />
            </Card>
            <Card title="Load">
              <div className="text-3xl font-semibold">{fmt(totalStrain, 1)}</div>
              <p className="mt-1 text-xs text-muted">Sum of detected-workout strain over {days} days (the 0–21 scale is logarithmic, so this is a rough volume index).</p>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
