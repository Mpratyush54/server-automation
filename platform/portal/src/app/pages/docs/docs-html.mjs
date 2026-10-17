// Keep fragment targets and links identical in the SPA and prerendered docs.
const escapeAttribute = (value) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const textContent = (html) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (entity, name) => {
        if (name.startsWith("#"))
          return String.fromCodePoint(
            Number(
              name[1].toLowerCase() === "x"
                ? "0x" + name.slice(2)
                : name.slice(1),
            ),
          );
        return (
          { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[
            name.toLowerCase()
          ] ?? entity
        );
      },
    );

export function prepareDocsHtml(html, markdownPath, origin) {
  const base = new URL(markdownPath, origin);
  html = html.replace(/\bhref="([^"]+)"/g, (attribute, href) => {
    let url;
    try {
      url = new URL(href.replaceAll("&amp;", "&"), base);
    } catch {
      return attribute;
    }
    if (url.origin !== base.origin || !url.pathname.startsWith("/docs/"))
      return attribute;
    const target =
      url.pathname === "/docs/index.md"
        ? "/docs"
        : url.pathname.replace(/\.md$/, "");
    return `href="${escapeAttribute(target + url.search + url.hash)}"`;
  });
  const used = new Set();
  return html.replace(
    /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (heading, level, attributes, content) => {
      const explicit = attributes.match(/\bid="([^"]+)"/);
      if (explicit) {
        used.add(explicit[1]);
        return heading;
      }
      const slug =
        textContent(content)
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "") || "section";
      let id = slug;
      let suffix = 0;
      while (used.has(id)) id = `${slug}-${++suffix}`;
      used.add(id);
      return `<h${level}${attributes} id="${id}">${content}</h${level}>`;
    },
  );
}
