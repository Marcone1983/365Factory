import { NextResponse } from 'next/server';
import { z } from 'zod';
import { cookies } from 'next/headers';
import { login, sessionCookieOptions, SESSION_COOKIE } from '@/lib/security/auth';

export const runtime = 'nodejs';

const Body = z.object({ email: z.string().email(), password: z.string().min(1).max(512) });

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Provide an email address and a password.' }, { status: 400 });
  }
  try {
    const result = await login({
      email: parsed.data.email,
      password: parsed.data.password,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
    const jar = await cookies();
    jar.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
    // Readable by the client so it can echo the token on mutating requests.
    jar.set('adaf_csrf', result.csrfToken, { httpOnly: false, sameSite: 'lax', path: '/', expires: result.expiresAt });
    return NextResponse.json({ user: result.user });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 401;
    return NextResponse.json({ error: (error as Error).message }, { status });
  }
}
