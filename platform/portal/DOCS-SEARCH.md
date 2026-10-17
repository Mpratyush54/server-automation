# Documentation search

Search runs locally in the browser, with no hosted search service or API key. The search index is fetched when the dialog first opens and reused while the docs are open. Query text stays in the browser.

`npm start`, `npm run build`, `npm run build:public`, and `npm run watch` generate `public/docs-search.json` before Angular starts. The generated file is ignored by Git. To refresh just the index after editing Markdown:

```sh
node scripts/build-docs-search.mjs
```

The index uses `public/docs/`, the same Markdown served by the portal. The public Docker build copies the repository's `docs/` there first. It indexes page titles, all heading sections, prose, and code examples. Section URLs use the same heading-ID helper as the interactive and prerendered docs.

Ranking favors headings and titles over incidental body matches, requires every meaningful query term, supports common tool aliases and limited spelling corrections, and limits repeated results from one page. Results show snippets and matching text without inserting query HTML.

Open search with its sidebar button, the mobile Search button, Ctrl/Cmd+K, or `/` outside a text field. Use arrow keys and Enter to select a section, or Escape to close. The dialog traps keyboard focus and restores it on close; normal modified link clicks remain available.

`npm run test:public` checks ranking, content matches, spelling mistakes, lazy loading, retry behavior, and navigation. The nginx routing suite also checks anonymous JSON access and validates every indexed section against prerendered heading IDs.
