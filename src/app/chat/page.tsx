import { redirect } from 'next/navigation';
import { getSession } from '@/lib/security/auth';
import { listThreads } from '@/lib/chat/agent';
import { getLlmProvider } from '@/lib/providers/registry';
import { CHAT_TOOLS } from '@/lib/chat/tools';
import { ChatClient } from './chat-client';

export const dynamic = 'force-dynamic';

export default async function ChatPage(): Promise<React.ReactElement> {
  const session = await getSession();
  if (!session) redirect('/login');

  const provider = getLlmProvider();
  const status = provider.status();
  const threads = listThreads(session.user.id);
  const available = CHAT_TOOLS.filter((t) => !t.permission || session.user.permissions.includes(t.permission));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Chat</h1>
          <p className="lede">
            Ask the factory in plain language. It answers only from real platform state, through {available.length} of{' '}
            {CHAT_TOOLS.length} tools your account may use.
          </p>
        </div>
      </div>

      {!status.configured ? (
        <div className="notice error" style={{ marginBottom: 18 }}>
          <strong>The chat has no language model.</strong> {provider.name} is not configured
          {status.detail ? ` — ${status.detail}` : ''}. Until a provider key is set, sending a message returns this same
          error rather than a fabricated answer. <a href="/health">See what to configure →</a>
        </div>
      ) : null}

      <ChatClient
        initialThreads={threads.map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt }))}
      />
    </>
  );
}
