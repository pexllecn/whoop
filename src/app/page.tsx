import Link from 'next/link';
import { OverviewCharts } from '@/components/overview-charts';
import { RingGauge } from '@/components/ring-gauge';
import { Badge, Banner, Card, DayNav, EmptyState, PageHeader, StatTile } from '@/components/ui';
import { BAND_META, STRESS_META, bandOf, fmt, fmtClock, fmtDate, fmtDuration, fmtSigned, stressLevelOf } from '@/lib/format';
import { latestDataDate, overview, today } from '@/lib/queries';
import { getDb } from '@/lib/storage/db';
import { addDays } from '@/lib/time';

export const dynamic = 'force-dynamic';

interface RecoveryInputs {
  zHrv: number;
  zRhr: number | null;
  zResp: number | null;
  core: number;
  sleepTerm: number;
  respPenalty: number;
  tempPenalty: number;
  composite: number;
  calibrating: boolean;
  hrvMethod: 'sws_weighted' | 'full_night' | null;
  baselines: { lnRmssd: { mean: number; sd: number; n: number } | null };
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const db = getDb();
  const params = await searchParams;
  const current = today(db);
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : latestDataDate(db);
  const data = overview(db, date);
  const s = data.day.summary;
  const tz = data.settings.timeZone;
  const inputs = s?.recoveryInputs ? (JSON.parse(s.recoveryInputs) as RecoveryInputs) : null;
  const band = s?.recovery != null ? bandOf(s.recovery) : null;
  const lnBaseline = data.baselines.lnRmssd;
  const hrvBaseline = lnBaseline ? Math.exp(lnBaseline.mean) : null;
  const rhrBaseline = data.baselines.restingHr?.mean ?? null;
  const respBaseline = data.baselines.respRate?.mean ?? null;
  const imported = data.day.imported;

  return (
    <>
      <PageHeader title={date === current ? 'Today' : fmtDate(date)} subtitle={`${fmtDate(date)} · ${tz}`}>
        {data.simulated && <Badge tone="warn">Simulated data</Badge>}
        <DayNav basePath="/" date={date} previous={addDays(date, -1)} next={date < current ? addDays(date, 1) : null} />
      </PageHeader>

      {!s && (
        <EmptyState title="No scored data for this day">
          Start the daemon (<code className="text-ink-2">npm run daemon</code>), connect over Web Bluetooth on the{' '}
          <Link className="text-accent underline" href="/device">Device</Link> page, import history on the{' '}
          <Link className="text-accent underline" href="/import">Import</Link> page, or seed simulated data with{' '}
          <code className="text-ink-2">npm run seed:demo</code>.
        </EmptyState>
      )}

      {s && (
        <>
          {s.calibrating && (
            <Banner tone="warn">
              Calibrating baselines{lnBaseline ? ` (${lnBaseline.n} of 4 nights)` : ''}. Recovery uses your own 30-day history, so the first nights are provisional.
            </Banner>
          )}

          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <RingGauge
                fraction={s.recovery === null ? null : s.recovery / 100}
                color={band ? BAND_META[band].color : 'var(--color-muted)'}
                label="Recovery"
                value={s.recovery === null ? '—' : fmt(s.recovery, 0)}
                unit={s.recovery === null ? undefined : '%'}
                ariaLabel={s.recovery === null ? 'Recovery not available' : `Recovery ${Math.round(s.recovery)} percent, ${BAND_META[band!].label}`}
                caption={
                  band ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span style={{ color: BAND_META[band].color }} aria-hidden="true">{BAND_META[band].icon}</span>
                      {BAND_META[band].label}
                    </span>
                  ) : (
                    'Needs overnight HRV and a baseline'
                  )
                }
              />
            </Card>
            <Card>
              <RingGauge
                fraction={s.dayStrain === null ? null : s.dayStrain / 21}
                color="var(--color-strain)"
                label="Strain"
                value={s.dayStrain === null ? '—' : fmt(s.dayStrain, 1)}
                ariaLabel={`Day strain ${fmt(s.dayStrain, 1)} of 21`}
                caption={`TRIMP ${fmt(s.dayTrimp, 0)} · Edwards ${fmt(s.dayEdwards, 0)} · ${fmt(s.kcal, 0)} kcal`}
              />
            </Card>
            <Card>
              <RingGauge
                fraction={s.sleepPerformance === null ? null : s.sleepPerformance / 100}
                color="var(--color-sleep)"
                label="Sleep"
                value={s.sleepPerformance === null ? '—' : fmt(s.sleepPerformance, 0)}
                unit={s.sleepPerformance === null ? undefined : '%'}
                ariaLabel={`Sleep performance ${fmt(s.sleepPerformance, 0)} percent`}
                caption={
                  data.sleep ? (
                    <>
                      {fmtDuration(s.sleepActualMs)} asleep of {fmtDuration(s.sleepNeedMs)} needed ·{' '}
                      <Link className="text-accent hover:underline" href={`/sleep?date=${date}`}>
                        details
                      </Link>
                    </>
                  ) : (
                    'No main sleep detected'
                  )
                }
              />
            </Card>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatTile
              label="HRV (RMSSD)"
              value={fmt(s.hrvRmssd, 0)}
              unit="ms"
              delta={s.hrvRmssd && hrvBaseline ? `${fmtSigned(((s.hrvRmssd - hrvBaseline) / hrvBaseline) * 100, 0)}% vs baseline` : null}
              deltaGood={s.hrvRmssd && hrvBaseline ? s.hrvRmssd >= hrvBaseline : null}
            />
            <StatTile
              label="Resting HR"
              value={fmt(s.restingHr, 0)}
              unit="bpm"
              delta={s.restingHr && rhrBaseline ? `${fmtSigned(s.restingHr - rhrBaseline, 1)} vs baseline` : null}
              deltaGood={s.restingHr && rhrBaseline ? s.restingHr <= rhrBaseline : null}
            />
            <StatTile
              label="Respiratory rate"
              value={fmt(s.respRate, 1)}
              unit="rpm"
              delta={s.respRate && respBaseline ? `${fmtSigned(s.respRate - respBaseline, 1)} vs baseline` : null}
              deltaGood={null}
            />
            <StatTile
              label="Stress (avg)"
              value={fmt(s.stressAvg, 1)}
              unit="/ 3"
              hint={s.stressAvg === null ? 'no still minutes yet' : `${STRESS_META[stressLevelOf(s.stressAvg)].label} · ${fmt(s.stressHighMinutes, 0)} min high`}
            />
            <StatTile label="Energy" value={fmt(s.kcal, 0)} unit="kcal" hint="BMR + Keytel (HR)" />
            <StatTile label="Worn" value={fmtDuration((s.wornMinutes ?? 0) * 60_000)} hint={data.device?.batteryPct != null ? `battery ${data.device.batteryPct}%` : undefined} />
          </div>

          {imported && (imported.recovery !== null || imported.dayStrain !== null) && (
            <p className="mt-3 text-xs text-muted">
              Imported from your WHOOP export for this day (WHOOP&apos;s own values, shown for comparison): recovery {fmt(imported.recovery, 0)}%, strain{' '}
              {fmt(imported.dayStrain, 1)}, HRV {fmt(imported.hrvRmssd, 0)} ms, RHR {fmt(imported.restingHr, 0)} bpm.
            </p>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_22rem]">
            <OverviewCharts
              data={{
                timeZone: tz,
                range: data.range,
                stressEnd: data.stressEnd,
                heartRate: data.heartRate,
                stress: data.stress,
                trend: data.trend.map((d) => ({
                  date: d.date,
                  recovery: d.recovery,
                  dayStrain: d.dayStrain,
                  hrvRmssd: d.hrvRmssd,
                  restingHr: d.restingHr,
                  sleepActualMs: d.sleepActualMs,
                  sleepNeedMs: d.sleepNeedMs,
                })),
                baselines: data.baselineHistory,
              }}
            />

            <div className="grid content-start gap-4">
              <Card title="How recovery was computed" subtitle="Every term, so the score is never a black box">
                {inputs ? (
                  <dl className="space-y-1.5 text-sm tabular">
                    {[
                      ['Z HRV (ln RMSSD)', fmtSigned(inputs.zHrv, 2)],
                      ['Z RHR (inverted)', inputs.zRhr === null ? '—' : fmtSigned(inputs.zRhr, 2)],
                      ['Core 0.65·Z_HRV + 0.35·Z_RHR', fmtSigned(inputs.core, 2)],
                      ['Sleep term', fmtSigned(inputs.sleepTerm, 2)],
                      ['Respiration penalty', inputs.respPenalty ? `−${fmt(inputs.respPenalty, 2)}` : '0'],
                      ['Skin-temperature penalty', inputs.tempPenalty ? `−${fmt(inputs.tempPenalty, 2)}` : '0'],
                      ['Composite', fmtSigned(inputs.composite, 2)],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <dt className="text-ink-2">{k}</dt>
                        <dd className="text-ink">{v}</dd>
                      </div>
                    ))}
                    <div className="border-t border-hair pt-2 text-xs text-muted">
                      Recovery = 100 / (1 + e^−(0.708 + 0.944·composite)). At baseline the composite is 0 and recovery is 67 %. HRV method:{' '}
                      {inputs.hrvMethod === 'sws_weighted' ? 'slow-wave weighted' : 'whole night'}
                      {inputs.baselines.lnRmssd ? `, baseline n = ${inputs.baselines.lnRmssd.n}` : ''}.
                    </div>
                  </dl>
                ) : (
                  <p className="text-sm text-muted">Recovery needs a detected main sleep with enough clean R-R intervals and at least one previous night for a baseline.</p>
                )}
              </Card>

              <Card title="Workouts" subtitle={date === current ? 'Today' : fmtDate(date, 'short')}>
                {data.workouts.length ? (
                  <ul className="space-y-3">
                    {data.workouts.map((w) => (
                      <li key={w.id} className="flex items-center justify-between gap-3 text-sm">
                        <div>
                          <div className="text-ink">{w.sport}</div>
                          <div className="text-xs text-muted">
                            {fmtClock(w.startTs, tz)} · {fmtDuration(w.endTs - w.startTs)} · {w.source === 'openpulse' ? 'detected' : w.source.replace('_', ' ')}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-ink tabular">{fmt(w.strain, 1)}</div>
                          <div className="text-xs text-muted">strain</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">No workouts.</p>
                )}
                <Link className="mt-3 inline-block text-xs text-accent hover:underline" href="/workouts">
                  All workouts →
                </Link>
              </Card>

              {data.naps.length > 0 && (
                <Card title="Naps">
                  <ul className="space-y-1 text-sm">
                    {data.naps.map((n) => (
                      <li key={n.id} className="flex justify-between text-ink-2">
                        <span>{fmtClock(n.startTs, tz)}</span>
                        <span className="tabular">{fmtDuration((n.lightMs ?? 0) + (n.deepMs ?? 0) + (n.remMs ?? 0))}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <p className="px-1 text-xs leading-relaxed text-muted">
                Scores are OpenPulse estimates computed on this computer from your strap&apos;s heart rate and R-R intervals using published formulas. They are not
                WHOOP&apos;s proprietary scores and are not medical advice.
              </p>
            </div>
          </div>
        </>
      )}
    </>
  );
}
