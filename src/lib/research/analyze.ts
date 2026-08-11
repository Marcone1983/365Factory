/**
 * Language-neutral lexical analysis applied to every fetched document before it
 * reaches an LLM: language identification, keyword extraction, entity spotting
 * and lexicon sentiment. Doing this deterministically keeps the expensive model
 * focused on judgement rather than on parsing, and gives the trend engine
 * features it can cluster on without any API call.
 */

const STOPWORDS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'has', 'are', 'was', 'were', 'you', 'your', 'not', 'but', 'all', 'can', 'will', 'would', 'they', 'their', 'there', 'about', 'more', 'been', 'when', 'what', 'which', 'into', 'than', 'them', 'some', 'just', 'like', 'only', 'also', 'other', 'over', 'after', 'most', 'because', 'how', 'why', 'who', 'its', 'our', 'out', 'get', 'one', 'use', 'used', 'using', 'make', 'made', 'even', 'very', 'much', 'many', 'any', 'his', 'her', 'she', 'him'],
  it: ['che', 'per', 'con', 'non', 'una', 'del', 'della', 'sono', 'come', 'più', 'anche', 'nel', 'nella', 'alla', 'dei', 'delle', 'gli', 'questo', 'questa', 'essere', 'stato', 'hanno', 'ma', 'se', 'da', 'un', 'il', 'lo', 'la', 'le', 'ed', 'ho', 'sul', 'sulla'],
  es: ['que', 'los', 'las', 'del', 'con', 'para', 'por', 'una', 'como', 'más', 'pero', 'sus', 'este', 'esta', 'son', 'han', 'ser', 'está', 'muy', 'sin', 'sobre', 'todo', 'ya', 'les'],
  fr: ['les', 'des', 'une', 'pour', 'que', 'dans', 'qui', 'pas', 'sur', 'plus', 'avec', 'est', 'sont', 'être', 'cette', 'nous', 'vous', 'leur', 'aux', 'par', 'ont', 'mais'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für', 'auch', 'sich', 'auf', 'des', 'dem', 'den', 'von', 'werden', 'wird', 'sind', 'aber', 'oder', 'kann'],
  pt: ['que', 'para', 'com', 'uma', 'dos', 'das', 'não', 'mais', 'como', 'por', 'são', 'está', 'foi', 'pelo', 'pela', 'seu', 'sua', 'mas', 'isso'],
};

const POSITIVE = new Set([
  'great', 'excellent', 'love', 'loved', 'amazing', 'awesome', 'perfect', 'best', 'helpful', 'useful', 'fast', 'smooth', 'intuitive', 'reliable', 'beautiful', 'powerful', 'simple', 'easy', 'recommend', 'recommended', 'brilliant', 'solid', 'polished', 'delightful', 'affordable', 'worth', 'impressive', 'seamless', 'responsive', 'stable', 'clean', 'elegant', 'favorite', 'favourite', 'improved', 'improvement', 'wins', 'winner', 'growth', 'growing', 'surge', 'boom', 'demand', 'popular', 'adoption', 'breakthrough', 'innovative',
]);

const NEGATIVE = new Set([
  'bad', 'terrible', 'awful', 'hate', 'hated', 'worst', 'useless', 'broken', 'buggy', 'bug', 'bugs', 'crash', 'crashes', 'crashing', 'slow', 'laggy', 'lag', 'expensive', 'overpriced', 'scam', 'spam', 'ads', 'paywall', 'clunky', 'confusing', 'complicated', 'frustrating', 'frustrated', 'annoying', 'unusable', 'unreliable', 'fails', 'failed', 'failure', 'missing', 'lacks', 'lacking', 'limited', 'disappointing', 'disappointed', 'regret', 'refund', 'uninstall', 'abandoned', 'outdated', 'deprecated', 'insecure', 'privacy', 'tracking', 'bloated', 'freezes', 'wish', 'problem', 'problems', 'issue', 'issues', 'difficult', 'hard', 'impossible', 'cannot', 'struggle', 'struggling', 'pain', 'painful', 'tedious', 'manual', 'workaround',
]);

const NEGATORS = new Set(['not', 'no', 'never', 'none', "n't", 'without', 'cannot', 'non', 'nessun', 'nunca', 'ne', 'kein', 'nie']);
const INTENSIFIERS = new Set(['very', 'extremely', 'really', 'so', 'incredibly', 'totally', 'absolutely', 'super', 'molto', 'muy', 'très', 'sehr']);

/** Pain-signal cues: recurring phrasings that mark an unmet need. */
const PAIN_PATTERNS: readonly RegExp[] = [
  /\bis there (?:any|an|a)?\s*(?:app|tool|way|software|game)\b/i,
  /\bi wish (?:there was|there were|it could|i could)\b/i,
  /\blooking for (?:an?|some)\b/i,
  /\bhow do (?:i|you)\b/i,
  /\bno (?:app|tool|solution|option) (?:that|for|to)\b/i,
  /\bwhy (?:is|does|isn't|doesn't)\b/i,
  /\bevery (?:app|tool) (?:i|we) (?:tried|used)\b/i,
  /\balternative to\b/i,
  /\bstill (?:no|not)\b/i,
  /\bhas to be (?:a )?better way\b/i,
];

export interface Analysis {
  readonly language: string;
  readonly keywords: readonly string[];
  readonly entities: readonly string[];
  readonly sentiment: number;
  readonly painScore: number;
  readonly painQuotes: readonly string[];
}

export function detectLanguage(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}']+/gu)?.slice(0, 2000) ?? [];
  if (words.length < 12) return 'und';
  const counts = new Map<string, number>();
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    const set = new Set(stops);
    counts.set(lang, words.filter((w) => set.has(w)).length);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top || top[1] < Math.max(3, words.length * 0.01)) return 'und';
  return top[0];
}

export function extractKeywords(text: string, language: string, limit = 20): string[] {
  const stops = new Set([...(STOPWORDS[language] ?? []), ...(STOPWORDS.en ?? [])]);
  const words = (text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'-]{2,}/gu) ?? []).filter((w) => !stops.has(w) && w.length <= 28);
  const unigrams = new Map<string, number>();
  for (const word of words) unigrams.set(word, (unigrams.get(word) ?? 0) + 1);

  // Bigrams capture the domain phrases that matter ("habit tracker", "offline sync").
  const bigrams = new Map<string, number>();
  for (let i = 0; i + 1 < words.length; i += 1) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    bigrams.set(phrase, (bigrams.get(phrase) ?? 0) + 1);
  }

  const scored: Array<[string, number]> = [
    ...[...unigrams.entries()].map(([w, n]) => [w, n * Math.log(1 + w.length)] as [string, number]),
    ...[...bigrams.entries()].filter(([, n]) => n >= 2).map(([w, n]) => [w, n * 2.2] as [string, number]),
  ];
  return scored
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

export function extractEntities(text: string, limit = 25): string[] {
  const counts = new Map<string, number>();
  // Capitalised multi-word sequences and CamelCase/branded tokens.
  const matches = text.match(/\b[A-Z][\p{L}\p{N}]*(?:[ ][A-Z][\p{L}\p{N}]*){0,3}\b|\b[a-z]+[A-Z][\p{L}\p{N}]*\b/gu) ?? [];
  const stops = new Set([...(STOPWORDS.en ?? []).map((s) => s[0]?.toUpperCase() + s.slice(1))]);
  for (const raw of matches) {
    const value = raw.trim();
    if (value.length < 3 || value.length > 60) continue;
    if (stops.has(value)) continue;
    if (/^(The|This|That|These|Those|There|When|What|Why|How|And|But|For|With|From)\b/.test(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

/** Lexicon sentiment with negation and intensifier handling; returns -1..1. */
export function scoreSentiment(text: string): number {
  const tokens = text.toLowerCase().match(/[\p{L}']+/gu)?.slice(0, 5000) ?? [];
  if (tokens.length === 0) return 0;
  let score = 0;
  let hits = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    let value = 0;
    if (POSITIVE.has(token)) value = 1;
    else if (NEGATIVE.has(token)) value = -1;
    if (value === 0) continue;
    let modifier = 1;
    for (let back = 1; back <= 3 && i - back >= 0; back += 1) {
      const previous = tokens[i - back] as string;
      if (NEGATORS.has(previous)) modifier *= -0.85;
      else if (INTENSIFIERS.has(previous)) modifier *= 1.4;
    }
    score += value * modifier;
    hits += 1;
  }
  if (hits === 0) return 0;
  // Normalise into -1..1 with a soft saturation so long documents do not dominate.
  const normalised = score / Math.sqrt(hits * 4 + 1);
  return Math.max(-1, Math.min(1, normalised));
}

export function findPainSignals(text: string): { score: number; quotes: string[] } {
  const sentences = text.split(/(?<=[.!?\n])\s+/).filter((s) => s.length > 24 && s.length < 400);
  const quotes: string[] = [];
  let matches = 0;
  for (const sentence of sentences) {
    if (PAIN_PATTERNS.some((p) => p.test(sentence))) {
      matches += 1;
      if (quotes.length < 8) quotes.push(sentence.trim().slice(0, 300));
    }
  }
  const density = sentences.length === 0 ? 0 : matches / sentences.length;
  return { score: Math.max(0, Math.min(1, density * 6 + Math.min(matches, 5) * 0.08)), quotes };
}

export function analyze(text: string): Analysis {
  const language = detectLanguage(text);
  const pain = findPainSignals(text);
  return {
    language,
    keywords: extractKeywords(text, language),
    entities: extractEntities(text),
    sentiment: scoreSentiment(text),
    painScore: pain.score,
    painQuotes: pain.quotes,
  };
}
