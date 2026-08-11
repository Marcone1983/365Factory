'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function csrfToken(): string {
  return document.cookie.split('; ').find((part) => part.startsWith('adaf_csrf='))?.split('=')[1] ?? '';
}

type Action =
  | { action: 'enable'; name: string; enabled: boolean }
  | { action: 'trigger'; name: string }
  | { action: 'retime'; name: string; cron: string };

/**
 * Per-schedule controls. Each action posts to the schedules API and refreshes
 * the server-rendered row, so what is displayed after an action is the stored
 * state rather than an optimistic guess.
 */
export function ScheduleControls({
  name,
  enabled,
  cron,
  canTrigger,
}: {
  name: string;
  enabled: boolean;
  cron: string;
  canTrigger: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cron);
  const [message, setMessage] = useState<string | null>(null);

  async function send(body: Action): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: string; accepted?: boolean };
      if (!response.ok) {
        setMessage(payload.error ?? 'That did not work.');
        return;
      }
      if (payload.accepted) setMessage('Started — follow it in the activity stream.');
      setEditing(false);
      router.refresh();
    } catch {
      setMessage('The console could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          disabled={busy}
          onClick={() => void send({ action: 'enable', name, enabled: !enabled })}
          style={{ fontSize: 12.5, padding: '5px 10px' }}
        >
          {enabled ? 'Disable' : 'Enable'}
        </button>
        <button disabled={busy} onClick={() => setEditing((v) => !v)} style={{ fontSize: 12.5, padding: '5px 10px' }}>
          Retime
        </button>
        {canTrigger ? (
          <button
            disabled={busy}
            onClick={() => void send({ action: 'trigger', name })}
            style={{ fontSize: 12.5, padding: '5px 10px' }}
          >
            Run now
          </button>
        ) : null}
      </div>

      {editing ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="0 6 * * *"
            className="mono"
            style={{ width: 150, padding: '5px 8px', fontSize: 12.5 }}
          />
          <button
            data-variant="primary"
            disabled={busy || draft.trim() === cron}
            onClick={() => void send({ action: 'retime', name, cron: draft.trim() })}
            style={{ fontSize: 12.5, padding: '5px 10px' }}
          >
            Save
          </button>
        </div>
      ) : null}

      {message ? (
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          {message}
        </div>
      ) : null}
    </div>
  );
}
