import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const portal = fileURLToPath(new URL("../", import.meta.url));

export async function prerenderLanding({
  outputDir = join(portal, "dist/portal/browser"),
} = {}) {
  const directory = join(portal, "src/app/pages/landing");
  // Use the actual component markup and CSS, so the initial HTML and the
  // interactive page have one source. Fail if a future binding needs handling.
  const template = (
    await readFile(join(directory, "landing.component.html"), "utf8")
  )
    .replace(/\s+routerLink="([^"]*)"/g, ' href="$1"')
    .replace(/\s+\([^)]+\)="[^"]*"/g, "")
    .replace(
      /\{\{\s*installCopied\s*\?\s*['"]Copied['"]\s*:\s*['"]Copy commands['"]\s*\}\}/,
      "Copy commands",
    );
  if (/\{\{|\*ng|\s\[[^\]]+\]=/.test(template))
    throw new Error("Unhandled Angular binding in landing prerender");
  const css = (
    await readFile(join(directory, "landing.component.css"), "utf8")
  ).replaceAll(":host", ".landing-shell");
  const shell = await readFile(join(outputDir, "index.html"), "utf8");
  if (!shell.includes("<app-root></app-root>"))
    throw new Error("Build the portal before prerendering the landing page");
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": "https://platform.pratyushes.dev/#website",
        name: "Platform",
        url: "https://platform.pratyushes.dev/",
        description: "A self-hosted developer platform for Kubernetes.",
      },
      {
        "@type": "SoftwareApplication",
        "@id": "https://platform.pratyushes.dev/#software",
        name: "Platform",
        url: "https://platform.pratyushes.dev/",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Linux (Ubuntu)",
        description:
          "Self-hosted PaaS for GitOps deployments, databases, encrypted secrets, observability, and scoped MCP access.",
        downloadUrl:
          "https://github.com/Mpratyush54/server-automation/releases",
        sameAs: "https://github.com/Mpratyush54/server-automation",
      },
    ],
  };
  const document = shell
    .replace(
      "<app-root></app-root>",
      () =>
        `<app-root><style id="landing-initial-styles">${css}</style>${template}</app-root>`,
    )
    .replace(
      "</head>",
      () =>
        `<script type="application/ld+json">${JSON.stringify(structuredData)}</script></head>`,
    );
  await writeFile(join(outputDir, "index.html"), document);
  console.log(
    "Generated the landing page from its Angular template: readable HTML, canonical metadata, and product structured data.",
  );
  return document;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await prerenderLanding();
