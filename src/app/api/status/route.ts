import { NextResponse } from 'next/server';
import { capabilityReport } from '@/lib/config/capabilities';
import { budgetState, usageSince, startOfUtcDay } from '@/lib/ai/usage';
import { cacheStats } from '@/lib/cache';
import { androidToolchain } from '@/lib/build/toolchain';
import { browserStatus } from '@/lib/qa/browser';
import { errorMemoryStats } from '@/lib/knowledge/error-memory';
import { measureQuality } from '@/lib/improvement/engine';
import { breakerSnapshot } from '@/lib/providers/http';
import { requireUser } from '@/lib/security/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Everything the health page needs, in one honest snapshot. */
export async function GET(): Promise<NextResponse> {
  await requireUser('system:read');
  return NextResponse.json({
    capabilities: capabilityReport(),
    budget: budgetState(),
    usageToday: usageSince(startOfUtcDay()),
    cache: cacheStats(),
    android: androidToolchain(),
    browser: browserStatus(),
    errorMemory: errorMemoryStats(),
    quality: measureQuality(),
    circuits: breakerSnapshot(),
  });
}
