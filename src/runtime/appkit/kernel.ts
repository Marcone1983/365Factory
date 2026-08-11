/**
 * Application kernel for non-game products.
 *
 * A small reactive core — signals, a DOM builder, a hash router and a view
 * registry — with no framework dependency, so a generated application boots in
 * well under a second on a mid-range phone and the whole bundle stays small
 * enough to embed in an APK.
 */

export type Unsubscribe = () => void;

export interface ReadonlySignal<T> {
  get(): T;
  subscribe(listener: (value: T) => void): Unsubscribe;
}

export class Signal<T> implements ReadonlySignal<T> {
  private value: T;
  private readonly listeners = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  update(mutator: (current: T) => T): void {
    this.set(mutator(this.value));
  }

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
}

/** Derives a signal from others; recomputes when any dependency changes. */
export function computed<T>(dependencies: ReadonlyArray<ReadonlySignal<unknown>>, compute: () => T): ReadonlySignal<T> {
  const output = new Signal<T>(compute());
  for (const dependency of dependencies) {
    dependency.subscribe(() => output.set(compute()));
  }
  return output;
}

export type Child = Node | string | number | null | undefined | false;

export interface ElementOptions {
  readonly class?: string;
  readonly text?: string;
  readonly html?: string;
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
  readonly style?: Readonly<Record<string, string>>;
  readonly dataset?: Readonly<Record<string, string>>;
}

/** Typed element factory. `html` is only ever set from product-authored strings. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.html !== undefined) element.innerHTML = options.html;
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === false) element.removeAttribute(key);
    else element.setAttribute(key, String(value));
  }
  for (const [event, handler] of Object.entries(options.on ?? {})) {
    element.addEventListener(event, handler);
  }
  for (const [property, value] of Object.entries(options.style ?? {})) {
    element.style.setProperty(property, value);
  }
  for (const [key, value] of Object.entries(options.dataset ?? {})) {
    element.dataset[key] = value;
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function mount(target: HTMLElement, node: Node): void {
  target.replaceChildren(node);
}

export interface RouteContext {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
}

export interface Route {
  /** Pattern with `:name` segments, e.g. `/items/:id`. */
  readonly path: string;
  readonly title: string;
  render(context: RouteContext): Node | Promise<Node>;
}

export class Router {
  private readonly routes: Route[] = [];
  private current: string | null = null;
  private notFound: (path: string) => Node = (path) =>
    el('section', { class: 'view' }, [el('h1', { text: 'Not found' }), el('p', { text: `No screen is registered for ${path}` })]);

  constructor(
    private readonly outlet: HTMLElement,
    private readonly onNavigate?: (context: RouteContext, route: Route | null) => void,
  ) {}

  register(route: Route): this {
    this.routes.push(route);
    return this;
  }

  setNotFound(render: (path: string) => Node): this {
    this.notFound = render;
    return this;
  }

  start(): void {
    window.addEventListener('hashchange', () => void this.resolve());
    void this.resolve();
  }

  navigate(path: string): void {
    window.location.hash = path.startsWith('#') ? path : `#${path}`;
  }

  private async resolve(): Promise<void> {
    const raw = window.location.hash.replace(/^#/, '') || '/';
    const [pathname, search = ''] = raw.split('?');
    const path = pathname || '/';
    if (this.current === raw) return;
    this.current = raw;

    for (const route of this.routes) {
      const params = matchRoute(route.path, path);
      if (!params) continue;
      const context: RouteContext = { path, params, query: new URLSearchParams(search) };
      document.title = route.title;
      const node = await route.render(context);
      mount(this.outlet, node);
      this.outlet.scrollTo?.({ top: 0 });
      this.onNavigate?.(context, route);
      return;
    }
    mount(this.outlet, this.notFound(path));
    this.onNavigate?.({ path, params: {}, query: new URLSearchParams(search) }, null);
  }
}

export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i] as string;
    const actual = pathParts[i] as string;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

/** Formats a value for display without pulling in a date/number library. */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(navigator.language || 'en', options).format(value);
}

export function formatDate(value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  return new Intl.DateTimeFormat(navigator.language || 'en', options).format(new Date(value));
}

/** Registers the service worker and surfaces the PWA install prompt. */
export function setupPwa(options: { serviceWorkerUrl?: string; onInstallAvailable?: (prompt: () => Promise<void>) => void } = {}): void {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register(options.serviceWorkerUrl ?? './sw.js').catch(() => undefined);
    });
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    const deferred = event as Event & { prompt(): Promise<void> };
    options.onInstallAvailable?.(() => deferred.prompt());
  });
}

/** Reports runtime errors to the preview harness, mirroring the 3D engine. */
export function installDiagnostics(appName: string): void {
  const post = (type: string, payload: Record<string, unknown>): void => {
    const message = { source: 'adaf-runtime', type, payload, ts: Date.now() };
    try {
      window.parent?.postMessage(message, '*');
    } catch {
      /* standalone */
    }
  };
  window.addEventListener('error', (event) => {
    post('error', { kind: 'runtime_error', message: event.message, source: event.filename, line: event.lineno });
  });
  window.addEventListener('unhandledrejection', (event) => {
    post('error', { kind: 'unhandled_rejection', message: String(event.reason) });
  });
  window.addEventListener('load', () => {
    const timing = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    post('ready', { app: appName, loadMs: timing ? Math.round(timing.duration) : null });
  });
}
