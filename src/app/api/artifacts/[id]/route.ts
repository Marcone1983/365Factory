import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { getArtifact } from '@/lib/build/store';
import { requireUser } from '@/lib/security/auth';
import { audit } from '@/lib/security/audit';

export const runtime = 'nodejs';

const CONTENT_TYPES: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
  aab: 'application/octet-stream',
  'web-bundle': 'application/zip',
  mapping: 'text/plain; charset=utf-8',
  'source-archive': 'application/zip',
};

/** Streams a real build artifact from disk, with its checksum in the headers. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await requireUser('build:read');
  const { id } = await context.params;
  const artifact = getArtifact(id);
  if (!artifact) return NextResponse.json({ error: 'Artifact not found.' }, { status: 404 });
  if (!fs.existsSync(artifact.path)) {
    return NextResponse.json({ error: 'The artifact record exists but the file is missing from disk.' }, { status: 410 });
  }

  audit({
    actorType: 'user',
    actorId: session.user.id,
    action: 'artifact.download',
    targetType: 'artifact',
    targetId: artifact.id,
    metadata: { filename: artifact.filename, bytes: artifact.bytes },
  });

  const data = fs.readFileSync(artifact.path);
  return new Response(new Uint8Array(data), {
    headers: {
      'content-type': CONTENT_TYPES[artifact.kind] ?? 'application/octet-stream',
      'content-length': String(data.length),
      'content-disposition': `attachment; filename="${artifact.filename.replace(/"/g, '')}"`,
      'x-artifact-sha256': artifact.sha256,
      'x-artifact-signed': String(artifact.signed),
      'cache-control': 'private, no-store',
    },
  });
}
