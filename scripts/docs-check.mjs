#!/usr/bin/env node
// Minimal `docs` gate. warehouse-console builds a Docusaurus site for this job;
// this repo's docs/ is plain Markdown, so the equivalent check is structural:
//   1. every docs/**/*.md starts with an H1,
//   2. every relative link / image in docs/ and README.md resolves to a file,
//   3. docs/index.md links to every other doc (the "sidebar" cannot go stale),
//   4. README.md links to docs/index.md.
// Zero dependencies on purpose: the CI job needs no `npm ci` and no ui-kit checkout.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const errors = [];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function links(markdown) {
  // [text](target) and ![alt](target); fenced code is stripped first so
  // example snippets cannot produce false links.
  const stripped = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...stripped.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
}

function checkLinks(file) {
  const text = readFileSync(file, "utf8");
  for (const target of links(text)) {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
    const path = target.split("#")[0];
    if (path === "") continue;
    if (!existsSync(resolve(dirname(file), path))) {
      errors.push(`${relative(root, file)}: broken link -> ${target}`);
    }
  }
}

if (!existsSync(docsDir)) {
  console.error("docs/ is missing");
  process.exit(1);
}

const docs = walk(docsDir).filter((f) => f.endsWith(".md"));
for (const file of docs) {
  const text = readFileSync(file, "utf8");
  if (!/^# \S/m.test(text.split("\n").slice(0, 8).join("\n"))) {
    errors.push(`${relative(root, file)}: no H1 title in the first lines`);
  }
  checkLinks(file);
}

const index = join(docsDir, "index.md");
if (!existsSync(index)) {
  errors.push("docs/index.md is missing");
} else {
  const indexed = new Set(links(readFileSync(index, "utf8")).map((l) => resolve(docsDir, l.split("#")[0])));
  for (const file of docs) {
    if (file !== index && !indexed.has(file)) {
      errors.push(`${relative(root, file)}: not linked from docs/index.md`);
    }
  }
}

const readme = join(root, "README.md");
checkLinks(readme);
if (!links(readFileSync(readme, "utf8")).some((l) => l.split("#")[0] === "docs/index.md")) {
  errors.push("README.md does not link to docs/index.md");
}

if (errors.length > 0) {
  console.error(errors.map((e) => `docs-check: ${e}`).join("\n"));
  process.exit(1);
}
console.log(`docs-check: ${docs.length} docs OK`);
