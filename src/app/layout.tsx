import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getSession } from '@/lib/security/auth';
import { config } from '@/lib/config/env';

export const metadata: Metadata = {
  title: 'Autonomous Daily App Factory',
  description: 'Market intelligence, AI product invention, 3D generation, build and delivery — in one operating console.',
  manifest: '/manifest.webmanifest',
  applicationName: 'App Factory',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'App Factory' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/icon-192.png' },
};

export const viewport: Viewport = {
  themeColor: '#080a10',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

const NAV: ReadonlyArray<{ href: string; label: string; section?: string }> = [
  { href: '/', label: 'Overview', section: 'Factory' },
  { href: '/chat', label: 'Chat' },
  { href: '/discovery', label: 'Discovery' },
  { href: '/projects', label: 'Products' },
  { href: '/schedules', label: 'Automation', section: 'Operations' },
  { href: '/costs', label: 'Cost & cache' },
  { href: '/health', label: 'System health' },
];

export default async function RootLayout({ children }: { children: React.ReactNode }): Promise<React.ReactElement> {
  const session = await getSession();
  const cfg = config();

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-mark" aria-hidden="true">AF</div>
              <div className="brand-text">
                App Factory
                <small>{cfg.AUTONOMY_MODE} autonomy</small>
              </div>
            </div>
            <nav className="nav">
              {NAV.map((item) => (
                <span key={item.href}>
                  {item.section ? <div className="nav-section">{item.section}</div> : null}
                  <a href={item.href}>{item.label}</a>
                </span>
              ))}
            </nav>
            <div className="nav-section">Session</div>
            {session ? (
              <form action="/api/auth/logout" method="post" style={{ padding: '0 10px' }}>
                <div className="faint mono" style={{ fontSize: 11, marginBottom: 8, wordBreak: 'break-all' }}>
                  {session.user.email}
                  <br />
                  {session.user.role}
                </div>
                <button type="submit" style={{ width: '100%' }}>Sign out</button>
              </form>
            ) : (
              <a className="button" href="/login" style={{ display: 'block', textAlign: 'center', margin: '0 10px' }}>Sign in</a>
            )}
          </aside>
          <main className="main">{children}</main>
        </div>
        <script
          // Registers the offline shell. Inline so the console works on first load.
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}`,
          }}
        />
      </body>
    </html>
  );
}
