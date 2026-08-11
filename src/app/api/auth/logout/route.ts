import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession, revokeSession, SESSION_COOKIE } from '@/lib/security/auth';
import { audit } from '@/lib/security/audit';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const session = await getSession();
  if (session) {
    revokeSession(session.sessionId);
    audit({ actorType: 'user', actorId: session.user.id, action: 'auth.logout' });
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete('adaf_csrf');
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}
