import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { prepareDocsHtml } from "../src/app/pages/docs/docs-html.mjs";

const portal = fileURLToPath(new URL("../", import.meta.url));
const plainText = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code) =>
      String.fromCodePoint(
        Number(code[0].toLowerCase() === "x" ? "0x" + code.slice(1) : code),
      ),
    )
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (_, name) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[name],
    )
    .replace(/\s+/g, " ")
    .trim();
async function files(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      result.push(
        ...(await files(
          join(directory, entry.name),
          prefix + entry.name + "/",
        )),
      );
    else if (entry.name.endsWith(".md")) result.push(prefix + entry.name);
  }
  return result.sort();
}
export async function buildDocsSearch({
  docsDir = join(portal, "public/docs"),
  output = join(portal, "public/docs-search.json"),
} = {}) {
  const documents = await files(docsDir);
  const entries = [];
  for (const file of documents) {
    const html = prepareDocsHtml(
      await marked.parse(await readFile(join(docsDir, file), "utf8")),
      "/docs/" + file,
      "https://platform.pratyushes.dev",
    );
    const headings = [
      ...html.matchAll(/<h([1-6])\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g),
    ];
    const title = plainText(
      headings.find((heading) => heading[1] === "1")?.[3] ||
        file.replace(/\.md$/, ""),
    );
    const path = file === "index.md" ? "/docs" : "/docs/" + file.slice(0, -3);
    const section = file.includes("/")
      ? file
          .slice(0, file.lastIndexOf("/"))
          .split("/")
          .map((part) => part.replaceAll("-", " "))
          .join(" / ")
      : "Overview";
    for (const [index, heading] of headings.entries()) {
      const ownText = plainText(
        html.slice(
          heading.index + heading[0].length,
          headings[index + 1]?.index ?? html.length,
        ),
      );
      const text =
        ownText ||
        plainText(html.slice(heading.index + heading[0].length)).slice(0, 800);
      entries.push({
        url: path + (heading[1] === "1" ? "" : "#" + heading[2]),
        title,
        section,
        heading: plainText(heading[3]),
        text,
      });
    }
    if (!headings.length)
      entries.push({
        url: path,
        title,
        section,
        heading: title,
        text: plainText(html),
      });
  }
  const index = { version: 1, documents: documents.length, entries };
  await writeFile(output, JSON.stringify(index));
  return index;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const index = await buildDocsSearch();
  console.log(
    `Indexed ${index.documents} docs pages and ${index.entries.length} sections for local search.`,
  );
}
