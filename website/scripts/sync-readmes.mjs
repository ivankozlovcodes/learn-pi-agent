/**
 * Site sync script: copies each chapter README into a site page.
 *
 * Anti-drift design: site pages are not hand-written copies; they are regenerated before every docs:dev / docs:build.
 * It handles these things:
 * 1. Copy: chapters/<NN-name>/README.md → website/chapters/ (zh, root locale)
 *    and chapters/<NN-name>/README.en.md → website/en/chapters/ (en locale; chapters without one are skipped with a warning)
 * 2. frontmatter: title from the H1, description from the first paragraph (SEO)
 *
 * Chapter READMEs cross-reference each other as plain text "Chapter NN", never as in-repo relative links,
 * so the zh sync is a purely mechanical copy; the en output only rewrites site chapter links to /en/chapters/.
 * 3. canonical: each chapter page gets a canonical URL injected (SEO, avoids duplicate-content detection)
 *
 * Each target has its own output dir and its own stale cleanup; cleanup never crosses dirs.
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE_URL = "https://yiz-hhh.github.io/learn-pi-agent";

const chapterDirs = readdirSync(join(ROOT, "chapters"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const TARGETS = [
  {
    readme: "README.md",
    outDir: "website/chapters",
    urlPrefix: "/chapters",
    required: true,
    transform: (raw) => raw,
  },
  {
    readme: "README.en.md",
    outDir: "website/en/chapters",
    urlPrefix: "/en/chapters",
    required: false,
    transform: (raw) => raw.replace(/\]\(\.?\/chapters\//g, "](/en/chapters/"),
  },
];

for (const target of TARGETS) syncTarget(target);

function syncTarget({ readme, outDir, urlPrefix, required, transform }) {
  const outPath = join(ROOT, outDir);
  // Required targets must have a README in every chapter dir; optional ones only sync chapters that have it
  const names = required ? chapterDirs : chapterDirs.filter((name) => existsSync(join(ROOT, "chapters", name, readme)));
  for (const name of chapterDirs) {
    if (!names.includes(name)) console.warn(`Skipped: chapters/${name}/${readme} does not exist yet`);
  }

  let copied = 0;
  mkdirSync(outPath, { recursive: true });
  const currentPages = new Set(names.map((name) => `${name}.md`));
  for (const file of readdirSync(outPath)) {
    if (file.endsWith(".md") && !currentPages.has(file)) {
      unlinkSync(join(outPath, file));
      console.log(`Removed stale page: ${outDir}/${file}`);
    }
  }
  for (const name of names) {
    const readmePath = join(ROOT, "chapters", name, readme);
    const raw = readFileSync(readmePath, "utf-8"); // Required READMEs must exist; a missing file throws (prevents silently missing pages)
    const outFile = join(outPath, `${name}.md`);
    writeFileSync(outFile, buildPage(transform(raw), `${SITE_URL}${urlPrefix}/${name}`), "utf-8");
    copied++;
    console.log(`Synced: chapters/${name}/${readme} → ${outDir}/${name}.md`);
  }
  console.log(`\nDone: ${copied} pages synced to ${outDir}/`);
}

/** Assemble a page: frontmatter (YAML-safe quoting, includes the canonical head) + body. */
function buildPage(raw, canonical) {
  const { title, description } = extractFrontmatter(raw);
  // YAML-safe quoting: JSON string syntax is compatible with YAML double-quoted strings (escapes \n \t etc.)
  const yamlString = (value) => JSON.stringify(value);
  const head = [["link", { rel: "canonical", href: canonical }]];
  const frontmatter = [
    "---",
    title ? `title: ${yamlString(title)}` : undefined,
    description ? `description: ${yamlString(description)}` : undefined,
    `head: ${yamlString(head)}`,
    "---",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  return `${frontmatter}${raw}`;
}

function extractFrontmatter(text) {
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : undefined;
  const firstParagraph = text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#") && !line.startsWith(">"))
    .find((line) => line.trim().length > 10);
  const description = firstParagraph ? firstParagraph.replace(/[*`]/g, "").trim().slice(0, 150) : undefined;
  return { title, description };
}
