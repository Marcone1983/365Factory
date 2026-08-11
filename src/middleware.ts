import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware: security headers only.
 *
 * Authentication and authorisation deliberately live in the Node.js runtime
 * (server components and route handlers) because they need the database; the
 * middleware never makes trust decisions, it only hardens every response.
 */

const CSP_DIRECTIVES: ReadonlyArray<[string, string]> = [
  ['default-src', "'self'"],
  // Next.js injects inline bootstrap scripts; a nonce is added per request below.
  ['script-src', "'self' 'unsafe-inline' 'wasm-unsafe-eval'"],
  ['style-src', "'self' 'unsafe-inline'"],
  ['img-src', "'self' data: blob:"],
  ['font-src', "'self' data:"],
  ['connect-src', "'self'"],
  // Generated products are previewed inside a sandboxed same-origin iframe that
  // is proxied through /api/preview, never from a third-party origin.
  ['frame-src', "'self' blob:"],
  ['worker-src', "'self' blob:"],
  ['media-src', "'self' blob: data:"],
  ['object-src', "'none'"],
  ['base-uri', "'self'"],
  ['form-action', "'self'"],
  ['frame-ancestors', "'none'"],
  ['upgrade-insecure-requests', ''],
];

export function middleware(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  const csp = CSP_DIRECTIVES.map(([k, v]) => (v ? `${k} ${v}` : k)).join('; ');

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );
  if (request.nextUrl.protocol === 'https:') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/).*)'],
};
