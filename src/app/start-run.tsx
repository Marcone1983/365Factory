'use client';

import { useState } from 'react';

const STOP_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'competition', label: 'Research and score opportunities only' },
  { value: 'invention', label: 'Stop at the product concept' },
  { value: 'learning', label: 'Build the product end to end' },
];

function csrfToken(): string {
  return document.cookie.split('; ').find((part) => part.startsWith('adaf_csrf='))?.split('=')[1] ?? '';
}

/** Starts a factory run. The run itself is followed on the event stream. */
export function StartRun({ canRun }: { canRun: boolean }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState('');
  const [stopAfter, setStopAfter] = useState('competition');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!canRun) return null;

  async function start(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
        body: JSON.stringify({ objective, stopAfter }),
      });
      const body = (await response.json()) as { error?: string; blocked?: Array<{ capability: string; reason: string }> };
      if (!response.ok) {
        setMessage(
          body.blocked?.length
            ? `${body.error ?? 'Blocked.'} ${body.blocked.map((b) => `${b.capability}: ${b.reason}`).join(' ')}`
            : (body.error ?? 'The run could not be started.'),
        );
        return;
      }
      setMessage('Run accepted — follow it in the activity stream.');
      setObjective('');
    } catch {
      setMessage('The console could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button data-variant="primary" onClick={() => setOpen(true)}>Start a run</button>;
  }

  return (
    <div className="card" style={{ minWidth: 340, maxWidth: 420 }}>
      <div className="field">
        <label htmlFor="objective">What should the factory investigate?</label>
        <textarea
          id="objective"
          placeholder="e.g. tools freelance illustrators need but cannot find"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="stop">How far should it go?</label>
        <select id="stop" value={stopAfter} onChange={(event) => setStopAfter(event.target.value)}>
          {STOP_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      {message ? <div className="notice" style={{ marginBottom: 12 }}>{message}</div> : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button data-variant="primary" disabled={busy || objective.trim().length < 6} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Start'}
        </button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
