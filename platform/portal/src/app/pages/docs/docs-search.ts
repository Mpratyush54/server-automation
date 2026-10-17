export interface DocsSearchEntry {
  url: string;
  title: string;
  section: string;
  heading: string;
  text: string;
}
export interface DocsSearchIndex {
  version: number;
  documents: number;
  entries: DocsSearchEntry[];
}
export interface DocsSearchResult extends DocsSearchEntry {
  score: number;
  fuzzy: boolean;
  snippet: string;
}
export interface SearchTextPart {
  text: string;
  match: boolean;
}

const stopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'does',
  'for',
  'how',
  'i',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'the',
  'to',
  'with',
  'you',
  'your',
]);
const aliases: Record<string, string> = {
  postgresql: 'postgres',
  pg: 'postgres',
  k8s: 'kubernetes',
  db: 'database',
  databases: 'database',
  passwords: 'password',
  rotation: 'rotate',
  rotating: 'rotate',
  rotated: 'rotate',
  encrypted: 'encrypt',
  encryption: 'encrypt',
  secrets: 'secret',
  deployments: 'deployment',
  deploying: 'deploy',
  deployed: 'deploy',
  tokens: 'token',
  agents: 'agent',
};
function normalize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\bargo\s+cd\b/g, 'argocd')
    .replace(/\bsign[ -]in\b/g, 'login')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function tokens(value: string): string[] {
  return [
    ...new Set(
      normalize(value)
        .split(' ')
        .filter(Boolean)
        .map((word) => (Object.hasOwn(aliases, word) ? aliases[word] : word)),
    ),
  ];
}
function queryTokens(value: string): string[] {
  return tokens(value)
    .filter((word) => !stopWords.has(word))
    .slice(0, 12);
}

function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    if (Math.min(...current) > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}
export function prepareSearchEntries(entries: DocsSearchEntry[]) {
  return entries.map((entry) => ({
    entry,
    title: tokens(entry.title),
    heading: tokens(entry.heading),
    section: tokens(entry.section),
    path: tokens(entry.url.split('#')[0]),
    body: tokens(entry.text),
  }));
}
export type PreparedSearchEntries = ReturnType<typeof prepareSearchEntries>;

export function searchDocs(
  entries: PreparedSearchEntries,
  query: string,
  limit = 10,
): DocsSearchResult[] {
  const terms = queryTokens(query);
  if (!terms.length || normalize(query).length < 2) return [];
  const results: DocsSearchResult[] = [];
  for (const document of entries) {
    let score = 0,
      fuzzy = false,
      matches = true;
    for (const term of terms) {
      let best = 0;
      const fields = [
        [document.heading, 12],
        [document.title, 9],
        [document.path, 6],
        [document.section, 3],
        [document.body, 2],
      ] as const;
      for (const [words, weight] of fields) {
        if (words.includes(term)) best = Math.max(best, weight);
        else if (
          term.length >= 3 &&
          words.some((word) => word.startsWith(term))
        )
          best = Math.max(best, weight * 0.7);
      }
      if (!best && term.length >= 4) {
        const threshold = term.length >= 7 ? 2 : 1;
        for (const [words, weight] of fields) {
          if (
            words.some((word) => distance(term, word, threshold) <= threshold)
          )
            best = Math.max(best, weight * 0.45);
        }
        if (best) fuzzy = true;
      }
      if (!best) {
        matches = false;
        break;
      }
      score += best;
    }
    if (!matches) continue;
    const phrase = normalize(query);
    if (normalize(document.entry.heading).includes(phrase)) score += 20;
    if (normalize(document.entry.title).includes(phrase)) score += 15;
    if (!fuzzy) score += 8;
    const body = document.entry.text || document.entry.heading;
    const lower = body.toLowerCase();
    const positions = terms
      .map((term) => lower.indexOf(term))
      .filter((index) => index >= 0);
    let start = Math.max(
      0,
      (positions.length ? Math.min(...positions) : 0) - 65,
    );
    if (start) {
      const space = body.indexOf(' ', start);
      if (space >= 0) start = space + 1;
    }
    const snippet =
      (start ? '…' : '') +
      body.slice(start, start + 185) +
      (start + 185 < body.length ? '…' : '');
    results.push({ ...document.entry, score, fuzzy, snippet });
  }
  const counts = new Map<string, number>();
  return results
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .filter((result) => {
      const path = result.url.split('#')[0],
        count = counts.get(path) || 0;
      counts.set(path, count + 1);
      return count < 2;
    })
    .slice(0, limit);
}
export function highlightSearchText(
  text: string,
  query: string,
): SearchTextPart[] {
  const terms = queryTokens(query);
  if (!terms.length) return [{ text, match: false }];
  const pattern = new RegExp(
    '(' + terms.sort((a, b) => b.length - a.length).join('|') + ')',
    'gi',
  );
  return text
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({
      text: part,
      match: terms.some((term) => part.toLowerCase() === term),
    }));
}
