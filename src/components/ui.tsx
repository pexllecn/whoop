import Link from 'next/link';
import type { ReactNode } from 'react';

export function Card({ title, subtitle, actions, children, className = '' }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-hair bg-card p-5 ${className}`}>
      {(title || actions) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

export function StatTile({
  label,
  value,
  unit,
  delta,
  deltaGood,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  delta?: string | null;
  /** true = the delta direction is favourable, false = unfavourable, null = neutral. */
  deltaGood?: boolean | null;
  hint?: string;
}) {
  const deltaColor = deltaGood === true ? 'text-good' : deltaGood === false ? 'text-serious' : 'text-ink-2';
  return (
    <div className="rounded-2xl border border-hair bg-card px-4 py-3.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tracking-tight">{value}</span>
        {unit && <span className="text-sm text-ink-2">{unit}</span>}
      </div>
      {(delta || hint) && (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs">
          {delta && <span className={`${deltaColor} tabular`}>{delta}</span>}
          {hint && <span className="text-muted">{hint}</span>}
        </div>
      )}
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent' }) {
  const tones = {
    neutral: 'border-hair text-ink-2',
    good: 'border-good/40 text-good',
    warn: 'border-warn/40 text-warn',
    bad: 'border-bad/50 text-bad',
    accent: 'border-accent/50 text-accent',
  } as const;
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function Banner({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn' | 'bad'; children: ReactNode }) {
  const tones = {
    neutral: 'border-hair bg-card text-ink-2',
    warn: 'border-warn/40 bg-warn/5 text-ink',
    bad: 'border-bad/50 bg-bad/10 text-ink',
  } as const;
  return <div className={`mb-5 rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-hair px-6 py-10 text-center">
      <div className="text-sm font-medium text-ink">{title}</div>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function DayNav({ basePath, date, previous, next }: { basePath: string; date: string; previous: string; next: string | null }) {
  const cls = 'rounded-lg border border-hair px-3 py-1.5 text-sm text-ink-2 hover:bg-card hover:text-ink';
  return (
    <div className="flex items-center gap-2" aria-label="Choose day">
      <Link className={cls} href={`${basePath}?date=${previous}`} aria-label="Previous day">
        ←
      </Link>
      <span className="text-sm text-ink-2 tabular">{date}</span>
      {next ? (
        <Link className={cls} href={`${basePath}?date=${next}`} aria-label="Next day">
          →
        </Link>
      ) : (
        <span className={`${cls} opacity-40`} aria-hidden="true">
          →
        </span>
      )}
    </div>
  );
}

export function KeyValue({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="mt-0.5 text-ink tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
