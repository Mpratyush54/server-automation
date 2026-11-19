/**
 * Shared shape of the public legal pages (/terms, /privacy). The text lives in
 * terms.content.ts and privacy.content.ts as data, so both pages share one
 * template and prerender to static HTML for crawlers.
 */
export interface LegalBlock {
  /** A paragraph of plain text. */
  p?: string;
  /** A bulleted list of plain-text items. */
  list?: string[];
  /** Labelled facts, e.g. "What: …" rows. */
  rows?: { label: string; text: string }[];
}

export interface LegalSection {
  id: string;
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDoc {
  title: string;
  /** Route of the page, e.g. /terms. */
  path: string;
  /** ISO date the text last changed, shown as "Last updated". */
  updated: string;
  /** Human form of `updated`, e.g. "19 November 2026". */
  updatedLabel: string;
  summary: string[];
  sections: LegalSection[];
}

/** Who runs Cairn. Update when the company is registered (see the note in each document). */
export const OPERATOR = 'Neural Nexus';
export const LEGAL_EMAIL = 'legal@cairnpaas.dev';
export const PRIVACY_EMAIL = 'privacy@cairnpaas.dev';

/**
 * Give every block all three fields (null when unused). The prerenderer, like strict
 * templates, rejects reading a property an object does not have.
 */
export function normalizeDoc(doc: LegalDoc): LegalDoc {
  return {
    ...doc,
    sections: doc.sections.map(s => ({
      ...s,
      blocks: s.blocks.map(b => ({ p: b.p ?? null, list: b.list ?? null, rows: b.rows ?? null }) as unknown as LegalBlock),
    })),
  };
}
