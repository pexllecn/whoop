import { Importers } from '@/components/importer';
import { Card, PageHeader } from '@/components/ui';
import { SOURCE_LABEL, fmtRelative } from '@/lib/format';
import { deviceView } from '@/lib/queries';
import { getDb } from '@/lib/storage/db';

export const dynamic = 'force-dynamic';

export default function ImportPage() {
  const view = deviceView(getDb());
  return (
    <>
      <PageHeader title="Import history" subtitle="Bring in data recorded before OpenPulse. Files are read on this computer and never uploaded anywhere else." />
      <Importers />
      <Card title="Import runs" className="mt-4">
        {view.imports.length === 0 ? (
          <p className="text-sm text-muted">Nothing imported yet. Large exports can also be imported from the terminal: <code>npm run import -- ~/Downloads/export.zip</code></p>
        ) : (
          <ul className="divide-y divide-hair text-sm">
            {view.imports.map((run) => (
              <li key={run.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  <span className="text-ink">{SOURCE_LABEL[run.source] ?? run.source}</span> <span className="text-muted">· {run.filename}</span>
                </span>
                <span className={run.status === 'ok' ? 'text-ink-2' : 'text-bad'}>
                  {run.status === 'ok' ? run.counts : run.error} · {fmtRelative(run.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
