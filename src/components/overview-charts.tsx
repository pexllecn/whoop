'use client';

import { BAND_META, bandOf, fmt, fmtClock, fmtDayShort, fmtDuration } from '@/lib/format';
import { ColumnChart } from './charts/column-chart';
import { LineChart } from './charts/line-chart';
import { StressRibbon } from './charts/stress-ribbon';
import { Card } from './ui';

export interface TrendDay {
  date: string;
  recovery: number | null;
  dayStrain: number | null;
  hrvRmssd: number | null;
  restingHr: number | null;
  sleepActualMs: number | null;
  sleepNeedMs: number | null;
}

export interface OverviewChartData {
  timeZone: string;
  range: { start: number; end: number };
  /** End of the stress ribbon: the end of the day, or now for today. */
  stressEnd: number;
  heartRate: Array<{ t: number; mean: number; min: number; max: number }>;
  stress: Array<{ t: number; score: number }>;
  trend: TrendDay[];
  baselines: Array<{ date: string; lnMean: number | null; lnSd: number | null; rhrMean: number | null; rhrSd: number | null }>;
}

const dayX = (date: string) => Date.parse(`${date}T12:00:00Z`);

/** Ticks every `hours` hours across [start, end]. */
function hourTicks(start: number, end: number, hours: number): number[] {
  const ticks: number[] = [];
  for (let t = start; t <= end; t += hours * 3_600_000) ticks.push(t);
  return ticks;
}

export function OverviewCharts({ data }: { data: OverviewChartData }) {
  const { timeZone, range } = data;
  const baselineByDate = new Map(data.baselines.map((b) => [b.date, b]));
  const hrvBand = data.trend
    .map((d) => {
      const b = baselineByDate.get(d.date);
      return b?.lnMean != null && b.lnSd != null ? { x: dayX(d.date), lo: Math.exp(b.lnMean - b.lnSd), hi: Math.exp(b.lnMean + b.lnSd) } : null;
    })
    .filter((p): p is { x: number; lo: number; hi: number } => p !== null);
  const rhrBand = data.trend
    .map((d) => {
      const b = baselineByDate.get(d.date);
      return b?.rhrMean != null && b.rhrSd != null ? { x: dayX(d.date), lo: b.rhrMean - b.rhrSd, hi: b.rhrMean + b.rhrSd } : null;
    })
    .filter((p): p is { x: number; lo: number; hi: number } => p !== null);

  return (
    <div className="grid gap-4">
      <Card title="Heart rate today" subtitle="10-minute average with the minimum–maximum range shaded">
        {data.heartRate.length ? (
          <LineChart
            series={[{ id: 'hr', label: 'Heart rate', color: 'var(--color-hr)', points: data.heartRate.map((p) => ({ x: p.t, y: p.mean })) }]}
            band={{ label: 'min–max', color: 'var(--color-hr)', points: data.heartRate.map((p) => ({ x: p.t, lo: p.min, hi: p.max })) }}
            height={190}
            yFloor={30}
            gap={30 * 60_000}
            xTicks={hourTicks(range.start, range.end, 4)}
            formatY={(v) => `${Math.round(v)}`}
            formatXTick={(t) => fmtClock(t, timeZone)}
            formatXTooltip={(t) => `${fmtClock(t, timeZone)} · bpm`}
            ariaLabel="Heart rate across the day in beats per minute"
          />
        ) : (
          <p className="text-sm text-muted">No heart-rate data for this day yet.</p>
        )}
      </Card>

      <Card title="Stress" subtitle="0–3 scale, scored only while still and awake (movement and exercise excluded)">
        {data.stress.length ? (
          <StressRibbon points={data.stress} from={range.start} to={data.stressEnd} timeZone={timeZone} />
        ) : (
          <p className="text-sm text-muted">No stress readings yet. They need a minute of still, awake data with R-R intervals.</p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recovery, last 28 days" subtitle="OpenPulse estimate">
          <ColumnChart
            columns={data.trend.map((d) => ({
              key: d.date,
              label: fmtDayShort(d.date),
              value: d.recovery,
              color: d.recovery === null ? 'transparent' : BAND_META[bandOf(d.recovery)].color,
              detail: d.recovery === null ? undefined : BAND_META[bandOf(d.recovery)].label,
            }))}
            legend={(['green', 'yellow', 'red'] as const).map((b) => ({ label: BAND_META[b].label, color: BAND_META[b].color }))}
            max={100}
            formatY={(v) => `${Math.round(v)}%`}
            valueLabel="Recovery"
            ariaLabel="Daily recovery over the last 28 days"
          />
        </Card>
        <Card title="Day strain, last 28 days" subtitle="0–21 scale">
          <ColumnChart
            columns={data.trend.map((d) => ({ key: d.date, label: fmtDayShort(d.date), value: d.dayStrain, color: 'var(--color-strain)' }))}
            max={21}
            formatY={(v) => fmt(v, v % 1 === 0 ? 0 : 1)}
            valueLabel="Strain"
            ariaLabel="Daily strain over the last 28 days"
          />
        </Card>
        <Card title="Overnight HRV" subtitle="RMSSD (ms); shaded band = 30-day baseline ±1 SD">
          <LineChart
            series={[{ id: 'hrv', label: 'HRV (RMSSD)', color: 'var(--color-accent)', points: data.trend.map((d) => ({ x: dayX(d.date), y: d.hrvRmssd })) }]}
            band={hrvBand.length ? { label: 'baseline ±1 SD', color: 'var(--color-accent)', points: hrvBand } : undefined}
            height={180}
            yFloor={0}
            formatY={(v) => `${Math.round(v)}`}
            formatXTick={(t) => fmtDayShort(new Date(t).toISOString().slice(0, 10))}
            formatXTooltip={(t) => `${fmtDayShort(new Date(t).toISOString().slice(0, 10))} · ms`}
            ariaLabel="Overnight HRV per night with baseline band"
          />
        </Card>
        <Card title="Resting heart rate" subtitle="Lowest 5-minute average asleep (bpm); band = baseline ±1 SD">
          <LineChart
            series={[{ id: 'rhr', label: 'Resting HR', color: 'var(--color-hr)', points: data.trend.map((d) => ({ x: dayX(d.date), y: d.restingHr })) }]}
            band={rhrBand.length ? { label: 'baseline ±1 SD', color: 'var(--color-hr)', points: rhrBand } : undefined}
            height={180}
            formatY={(v) => fmt(v, 0)}
            formatXTick={(t) => fmtDayShort(new Date(t).toISOString().slice(0, 10))}
            formatXTooltip={(t) => `${fmtDayShort(new Date(t).toISOString().slice(0, 10))} · bpm`}
            ariaLabel="Resting heart rate per night with baseline band"
          />
        </Card>
      </div>

      <Card title="Sleep, last 28 days" subtitle="Hours asleep against the night's computed need">
        <LineChart
          series={[
            { id: 'asleep', label: 'Asleep', color: 'var(--color-sleep)', points: data.trend.map((d) => ({ x: dayX(d.date), y: d.sleepActualMs === null ? null : d.sleepActualMs / 3_600_000 })) },
            { id: 'need', label: 'Sleep need', color: 'var(--color-ink-2)', points: data.trend.map((d) => ({ x: dayX(d.date), y: d.sleepNeedMs === null ? null : d.sleepNeedMs / 3_600_000 })) },
          ]}
          height={180}
          yFloor={0}
          formatY={(v) => fmtDuration(v * 3_600_000)}
          formatYTick={(v) => `${fmt(v, v % 1 === 0 ? 0 : 1)} h`}
          formatXTick={(t) => fmtDayShort(new Date(t).toISOString().slice(0, 10))}
          formatXTooltip={(t) => fmtDayShort(new Date(t).toISOString().slice(0, 10))}
          ariaLabel="Hours asleep and sleep need per night"
        />
      </Card>
    </div>
  );
}
