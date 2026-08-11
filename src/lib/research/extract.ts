import * as cheerio from 'cheerio';

/**
 * Main-content extraction.
 *
 * A density-based readability pass: boilerplate containers are removed, every
 * remaining block is scored on text length, link density, paragraph count and
 * semantic tag weight, and the highest-scoring subtree becomes the article body.
 * Metadata is read from Open Graph, JSON-LD, and standard meta tags.
 */

export interface ExtractedDocument {
  readonly title: string;
  readonly content: string;
  readonly excerpt: string;
  readonly canonicalUrl: string | null;
  readonly language: string | null;
  readonly publishedAt: string | null;
  readonly author: string | null;
  readonly siteName: string | null;
  readonly wordCount: number;
  readonly links: readonly string[];
}

const BOILERPLATE = [
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'form', 'button',
  'nav', 'header', 'footer', 'aside', 'menu', 'template',
  '[role=navigation]', '[role=banner]', '[role=contentinfo]', '[aria-hidden=true]',
];

const BOILERPLATE_CLASS = /(?:^|[\s_-])(?:nav|menu|sidebar|footer|header|banner|advert|ads?|promo|cookie|consent|newsletter|subscribe|social|share|comment|related|recommend|breadcrumb|pagination|modal|popup|paywall)(?:$|[\s_-])/i;

const CONTENT_TAGS: Record<string, number> = {
  article: 40,
  main: 30,
  section: 8,
  div: 3,
  td: 1,
};

interface Candidate {
  score: number;
  text: string;
}

function normaliseWhitespace(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  // Reject clearly bogus dates rather than storing a wrong provenance timestamp.
  const year = new Date(ts).getUTCFullYear();
  if (year < 1995 || year > new Date().getUTCFullYear() + 1) return null;
  return new Date(ts).toISOString();
}

export function extractDocument(html: string, sourceUrl: string): ExtractedDocument {
  const $ = cheerio.load(html);

  const meta = (selector: string, attr = 'content'): string | undefined => $(selector).first().attr(attr);

  const jsonLd: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) jsonLd.push(...(parsed as Record<string, unknown>[]));
      else if (parsed && typeof parsed === 'object') jsonLd.push(parsed as Record<string, unknown>);
    } catch {
      /* malformed JSON-LD is common; ignore it */
    }
  });
  const ldValue = (key: string): string | undefined => {
    for (const entry of jsonLd) {
      const value = entry[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (value && typeof value === 'object' && 'name' in (value as Record<string, unknown>)) {
        const name = (value as Record<string, unknown>).name;
        if (typeof name === 'string') return name;
      }
    }
    return undefined;
  };

  const title =
    firstNonEmpty(
      meta('meta[property="og:title"]'),
      meta('meta[name="twitter:title"]'),
      ldValue('headline'),
      $('title').first().text(),
      $('h1').first().text(),
    ) ?? '';

  const canonicalUrl = firstNonEmpty(meta('link[rel="canonical"]', 'href'), meta('meta[property="og:url"]'));
  const language = firstNonEmpty($('html').attr('lang'), meta('meta[http-equiv="content-language"]'))?.slice(0, 5) ?? null;
  const publishedAt =
    parseDate(
      firstNonEmpty(
        meta('meta[property="article:published_time"]'),
        meta('meta[name="date"]'),
        meta('meta[itemprop="datePublished"]'),
        ldValue('datePublished'),
        $('time[datetime]').first().attr('datetime'),
      ),
    ) ?? null;
  const author = firstNonEmpty(meta('meta[name="author"]'), meta('meta[property="article:author"]'), ldValue('author'));
  const siteName = firstNonEmpty(meta('meta[property="og:site_name"]'));

  const links: string[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const resolved = new URL(href, sourceUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') links.push(resolved.href);
    } catch {
      /* unparsable href */
    }
  });

  for (const selector of BOILERPLATE) $(selector).remove();
  $('*').each((_i, el) => {
    const attrs = `${$(el).attr('class') ?? ''} ${$(el).attr('id') ?? ''}`;
    if (attrs.trim() && BOILERPLATE_CLASS.test(attrs)) $(el).remove();
  });

  let best: Candidate | null = null;
  $('article, main, section, div, td').each((_i, el) => {
    const node = $(el);
    const text = normaliseWhitespace(node.text());
    if (text.length < 200) return;
    const linkText = normaliseWhitespace(node.find('a').text()).length;
    const linkDensity = text.length === 0 ? 1 : linkText / text.length;
    if (linkDensity > 0.5) return;
    const paragraphs = node.find('p').length;
    const commas = (text.match(/[,，、;]/g) ?? []).length;
    const tagName = (el as { tagName?: string }).tagName?.toLowerCase() ?? 'div';
    const score =
      text.length * (1 - linkDensity) +
      paragraphs * 25 +
      commas * 3 +
      (CONTENT_TAGS[tagName] ?? 0) -
      node.find('div').length * 2;
    if (!best || score > best.score) best = { score, text };
  });

  const bodyText = best ? (best as Candidate).text : normaliseWhitespace($('body').text());
  const content = bodyText.slice(0, 120_000);
  const words = content.split(/\s+/).filter(Boolean);

  return {
    title: normaliseWhitespace(title).slice(0, 400),
    content,
    excerpt:
      firstNonEmpty(meta('meta[property="og:description"]'), meta('meta[name="description"]'), content.slice(0, 400))?.slice(0, 600) ??
      '',
    canonicalUrl,
    language,
    publishedAt,
    author: author?.slice(0, 200) ?? null,
    siteName: siteName?.slice(0, 200) ?? null,
    wordCount: words.length,
    links: [...new Set(links)].slice(0, 300),
  };
}

/** Extraction for JSON endpoints (Reddit, Hacker News, store APIs). */
export function extractJsonDocument(json: unknown, sourceUrl: string): ExtractedDocument {
  const flat: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || flat.join(' ').length > 100_000) return;
    if (typeof value === 'string') {
      if (value.length > 2) flat.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [, v] of Object.entries(value as Record<string, unknown>)) visit(v, depth + 1);
    }
  };
  visit(json, 0);
  const content = normaliseWhitespace(flat.join('\n')).slice(0, 120_000);
  return {
    title: new URL(sourceUrl).pathname.slice(0, 200),
    content,
    excerpt: content.slice(0, 400),
    canonicalUrl: sourceUrl,
    language: null,
    publishedAt: null,
    author: null,
    siteName: new URL(sourceUrl).host,
    wordCount: content.split(/\s+/).filter(Boolean).length,
    links: [],
  };
}
