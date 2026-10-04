'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card } from './ui';

type Kind = 'whoop' | 'apple';

const KINDS: Record<Kind, { title: string; subtitle: string; accept: string; help: string }> = {
  whoop: {
    title: 'WHOOP data export',
    subtitle: 'The ZIP the WHOOP app emails you (or its CSV files)',
    accept: '.zip,.csv',
    help: 'Stored as WHOOP’s own values, separate from OpenPulse scores. Imported HRV and RHR also seed your baselines for days without strap data.',
  },
  apple: {
    title: 'Apple Health export',
    subtitle: 'export.zip from the Health app, or export.xml',
    accept: '.zip,.xml',
    help: 'Heart rate, resting HR, HRV (SDNN, kept apart from RMSSD), respiratory rate, SpO2, wrist temperature, sleep stages and workouts. Parsed as a stream, so large exports are fine.',
  },
};

function Uploader({ kind }: { kind: Kind }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const meta = KINDS[kind];

  const upload = () => {
    if (!file) return;
    setResult(null);
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/import?kind=${kind}&filename=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
    xhr.onload = () => {
      setProgress(null);
      try {
        const body = JSON.parse(xhr.responseText) as Record<string, unknown>;
        if (xhr.status >= 400) {
          setResult({ ok: false, text: String(body.error ?? xhr.statusText) });
        } else {
          const parts = Object.entries(body)
            .filter(([k, v]) => ['days', 'sleeps', 'workouts', 'heartRateSamples'].includes(k) && typeof v === 'number')
            .map(([k, v]) => `${(v as number).toLocaleString()} ${k === 'heartRateSamples' ? 'heart-rate samples' : k}`);
          const range = body.dateRange as { from: string; to: string } | null;
          const warnings = (body.warnings as string[] | undefined) ?? [];
          setResult({ ok: true, text: `Imported ${parts.join(', ')}${range ? ` (${range.from} → ${range.to})` : ''}.${warnings.length ? ` Notes: ${warnings.join('; ')}` : ''}` });
          router.refresh();
        }
      } catch {
        setResult({ ok: false, text: `Unexpected response (${xhr.status})` });
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      setResult({ ok: false, text: 'Upload failed' });
    };
    xhr.send(file);
  };

  return (
    <Card title={meta.title} subtitle={meta.subtitle}>
      <p className="mb-3 text-xs text-muted">{meta.help}</p>
      <label className="block cursor-pointer rounded-xl border border-dashed border-hair px-4 py-6 text-center text-sm text-ink-2 hover:bg-raised">
        <input type="file" accept={meta.accept} className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file ? (
          <span>
            {file.name} · {(file.size / 1e6).toFixed(1)} MB
          </span>
        ) : (
          <span>Choose a file</span>
        )}
      </label>
      <button type="button" disabled={!file || progress !== null} onClick={upload} className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40">
        {progress === null ? 'Import' : progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Processing…'}
      </button>
      {result && <p className={`mt-3 text-sm ${result.ok ? 'text-ink-2' : 'text-bad'}`}>{result.text}</p>}
    </Card>
  );
}

export function Importers() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Uploader kind="whoop" />
      <Uploader kind="apple" />
    </div>
  );
}
