/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // better-sqlite3 and esbuild are native/binary packages: keep them external so the
  // Next.js server bundler does not attempt to trace or rewrite their binaries.
  serverExternalPackages: ['better-sqlite3', 'esbuild'],
  eslint: {
    dirs: ['src', 'scripts', 'tests'],
  },
  outputFileTracingExcludes: {
    '*': ['workspaces/**', 'var/**'],
  },
};

export default nextConfig;
