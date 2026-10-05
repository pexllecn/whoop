import { Hypnogram } from '@/components/charts/hypnogram';
import { StackedBar } from '@/components/charts/stacked-bar';
import { SleepTrend } from '@/components/sleep-trend';
import { Badge, Card, DayNav, EmptyState, KeyValue, PageHeader } from '@/components/ui';
import { SOURCE_LABEL, STAGE_META, fmt, fmtClock, fmtDate, fmtDuration } from '@/lib/format';
import { latestDataDate, sleepView, today } from '@/lib/queries';
import { getDb } from '@/lib/storage/db';
import { addDays } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function SleepPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const db = getDb();
  const params = await searchParams;
  const current = today(db);
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : latestDataDate(db);
  const view = sleepView(db, date);
  const s = view.session;
  const tz = view.timeZone;
  const asleep = s ? (s.lightMs ?? 0) + (s.deepMs ?? 0) + (s.remMs ?? 0) : 0;

  return (
    <>
      <PageHeader title="Sleep" subtitle={`Night ending ${fmtDate(date)}`}>
        {s && <Badge>{SOURCE_LABEL[s.source] ?? s.source}</Badge>}
        <DayNav basePath="/sleep" date={date} previous={addDays(date, -1)} next={date < current ? addDays(date, 1) : null} />
      </PageHeader>

      {!s ? (
        <EmptyState title="No sleep recorded for this night">Wear the strap overnight with the daemon running, or import history.</EmptyState>
      ) : (
        <div className="grid gap-4">
          <Card title={`${fmtClock(s.startTs, tz)} – ${fmtClock(s.endTs, tz)}`} subtitle={`${fmtDuration(s.endTs - s.startTs)} in bed`}>
            <KeyValue
              items={[
                ['Asleep', fmtDuration(asleep)],
                ['Performance', s.performance === null ? '—' : `${fmt(s.performance, 0)}%`],
                ['Efficiency', s.efficiency === null ? '—' : `${fmt(s.efficiency, 0)}%`],
                ['Consistency', s.consistency === null ? '—' : `${fmt(s.consistency, 0)}%`],
                ['Disturbances', fmt(s.disturbances)],
                ['Respiratory rate', s.respRate === null ? '—' : `${fmt(s.respRate, 1)} rpm`],
                ['Overnight HRV', s.overnightRmssd === null ? '—' : `${fmt(s.overnightRmssd, 0)} ms`],
                ['Resting HR', s.restingHr === null ? '—' : `${fmt(s.restingHr, 0)} bpm`],
                ['Sleep need', fmtDuration(s.needMs)],
              ]}
            />
          </Card>

          {view.epochs.length > 0 && (
            <Card title="Hypnogram" subtitle="30-second epochs classified from heart rate, HRV and motion">
              <Hypnogram epochs={view.epochs.map((e) => ({ t: e.t, stage: e.stage }))} timeZone={tz} />
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Stages" subtitle="Share of time in bed">
              <StackedBar
                ariaLabel="Time in each sleep stage"
                segments={(['awake', 'rem', 'light', 'deep'] as const).map((k) => {
                  const ms = (k === 'awake' ? s.awakeMs : k === 'rem' ? s.remMs : k === 'light' ? s.lightMs : s.deepMs) ?? 0;
                  return { label: STAGE_META[k].label, value: ms, color: STAGE_META[k].color, display: fmtDuration(ms) };
                })}
              />
            </Card>
            <Card title="Sleep need" subtitle="Baseline + strain supplement + decayed debt from the last three nights">
              {s.needMs !== null && s.needBaselineMs !== null ? (
                <>
                  <StackedBar
                    ariaLabel="Sleep need breakdown"
                    segments={[
                      { label: 'Baseline', value: s.needBaselineMs, color: 'var(--color-sleep)', display: fmtDuration(s.needBaselineMs) },
                      { label: 'Strain', value: s.needStrainMs ?? 0, color: 'var(--color-strain)', display: fmtDuration(s.needStrainMs ?? 0) },
                      { label: 'Debt', value: s.needDebtMs ?? 0, color: 'var(--color-stage-light)', display: fmtDuration(s.needDebtMs ?? 0) },
                    ]}
                  />
                  <p className="mt-3 text-sm text-ink-2">
                    You slept {fmtDuration(asleep)} of {fmtDuration(s.needMs)} needed
                    {asleep < s.needMs ? `, ${fmtDuration(s.needMs - asleep)} short` : ''}.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted">Sleep need is computed for OpenPulse-scored nights.</p>
              )}
            </Card>
          </div>

          {view.recent.length > 1 && (
            <Card title="Last 14 nights">
              <SleepTrend
                nights={view.recent.map((n) => ({ date: n.date, asleepMs: (n.lightMs ?? 0) + (n.deepMs ?? 0) + (n.remMs ?? 0), needMs: n.needMs, performance: n.performance }))}
              />
            </Card>
          )}

          {view.naps.length > 0 && (
            <Card title="Naps">
              <ul className="divide-y divide-hair text-sm">
                {view.naps.map((n) => (
                  <li key={n.id} className="flex justify-between py-2">
                    <span className="text-ink-2">
                      {fmtClock(n.startTs, tz)} – {fmtClock(n.endTs, tz)}
                    </span>
                    <span className="tabular">{fmtDuration((n.lightMs ?? 0) + (n.deepMs ?? 0) + (n.remMs ?? 0))} asleep</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
