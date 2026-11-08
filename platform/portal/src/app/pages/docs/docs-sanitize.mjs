// Shared by the SPA (docs.component.ts) and the build-time prerenderer
// (scripts/prerender-docs.mjs) so both emit the same sanitized article HTML.
import createDOMPurify from "dompurify";

// Docs are Markdown that may embed raw HTML (e.g. the dashboard cards in
// architecture/overview.md). Keep the HTML profile (headings, code, tables,
// lists, links, images, div/span with class/id, GFM task-list checkboxes) and
// drop anything that can execute script or restyle the page: <script>, event
// handler attributes, javascript: URLs, SVG/MathML, <style>, inline styles,
// forms and embedded frames.
const DOCS_PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    "style", "form", "button", "textarea", "select", "option",
    "iframe", "object", "embed", "base", "link", "meta",
  ],
  FORBID_ATTR: ["style", "srcset", "action", "formaction"],
  ALLOW_DATA_ATTR: false,
};

// DOMPurify drops ids that shadow a document/form property ("before",
// "after", "close", ...) to prevent DOM clobbering. Headings and the API card
// wrappers are never exposed as named properties on `document`, so keep their
// slug ids: the table of contents and #fragment links depend on them.
const SLUG_ID_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "div"]);
const SLUG_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Sanitize rendered docs HTML, then turn ```mermaid fences into
 * `<div class="mermaid">` containers. The mermaid source is only ever assigned
 * as textContent, so a fence containing `</div><script>` stays inert text.
 */
export function sanitizeDocsHtml(html, win = globalThis.window) {
  const purify = createDOMPurify(win);
  purify.addHook("uponSanitizeAttribute", (node, data) => {
    if (
      data.attrName === "id" &&
      SLUG_ID_TAGS.has(node.nodeName.toLowerCase()) &&
      SLUG_ID.test(data.attrValue)
    ) {
      data.forceKeepAttr = true;
    }
  });
  const clean = purify.sanitize(html, DOCS_PURIFY_CONFIG);
  const doc = win.document;
  const template = doc.createElement("template");
  template.innerHTML = clean;
  for (const code of template.content.querySelectorAll(
    "pre > code.language-mermaid",
  )) {
    const diagram = doc.createElement("div");
    diagram.className = "mermaid";
    diagram.textContent = (code.textContent || "").trim();
    code.parentElement.replaceWith(diagram);
  }
  return template.innerHTML;
}
