import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('net.dispatcher');

/**
 * Outbound HTTP transport configuration.
 *
 * Node's global `fetch` ignores the conventional proxy environment variables, so
 * a platform deployed behind a corporate egress proxy would silently fail to
 * reach any provider. This installs a dispatcher that honours HTTPS_PROXY /
 * HTTP_PROXY / NO_PROXY, plus sane connection and header timeouts, once per
 * process.
 */

let installed = false;

function parseNoProxy(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function shouldBypassProxy(hostname: string, noProxy: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return noProxy.some((entry) => {
    if (entry === '*') return true;
    const clean = entry.startsWith('.') ? entry.slice(1) : entry;
    return host === clean || host.endsWith(`.${clean}`);
  });
}

export function installGlobalDispatcher(): void {
  if (installed) return;
  installed = true;

  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  const noProxy = parseNoProxy(process.env.NO_PROXY ?? process.env.no_proxy);

  const direct = new Agent({
    connectTimeout: 15_000,
    headersTimeout: 60_000,
    bodyTimeout: 120_000,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  });

  if (!proxyUrl) {
    setGlobalDispatcher(direct);
    return;
  }

  let proxy: ProxyAgent;
  try {
    proxy = new ProxyAgent({ uri: proxyUrl, connectTimeout: 15_000, headersTimeout: 60_000, bodyTimeout: 120_000 });
  } catch (error) {
    log.warn('invalid proxy configuration; using direct connections', { error: (error as Error).message });
    setGlobalDispatcher(direct);
    return;
  }

  // Route per-request: NO_PROXY hosts must not be tunnelled.
  const router: Dispatcher = new Proxy(proxy, {
    get(target, property, receiver) {
      if (property === 'dispatch') {
        return function dispatch(this: unknown, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
          const origin = typeof options.origin === 'string' ? options.origin : options.origin?.href;
          let hostname = '';
          try {
            hostname = origin ? new URL(origin).hostname : '';
          } catch {
            hostname = '';
          }
          const agent = hostname && shouldBypassProxy(hostname, noProxy) ? direct : target;
          return agent.dispatch(options, handler);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Dispatcher;

  setGlobalDispatcher(router);
  log.info('outbound proxy configured', { proxy: proxyUrl.replace(/\/\/[^@]*@/, '//***@'), bypassEntries: noProxy.length });
}
