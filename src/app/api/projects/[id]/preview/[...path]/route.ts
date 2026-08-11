import { NextResponse } from 'next/server';
import { readPreviewFile, PREVIEW_CONTENT_SECURITY_POLICY } from '@/lib/preview/server';
import { requireUser } from '@/lib/security/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves the generated product's build output to the console iframe.
 *
 * Same-origin so the console can frame it, but the response carries the
 * restrictive preview CSP and the iframe is sandboxed, so the untrusted product
 * cannot reach the console's own APIs.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; path: string[] }> },
): Promise<Response> {
  await requireUser('preview:read');
  const { id, path } = await context.params;
  const file = readPreviewFile(id, path.join('/'));
  if (!file) return NextResponse.json({ error: 'Not found in the project build output.' }, { status: 404 });

  return new Response(new Uint8Array(file.data), {
    headers: {
      'content-type': file.contentType,
      'content-length': String(file.data.length),
      'content-security-policy': PREVIEW_CONTENT_SECURITY_POLICY,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
