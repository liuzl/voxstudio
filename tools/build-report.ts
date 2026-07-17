#!/usr/bin/env bun
/**
 * Builds docs/technical-report.html from docs/technical-report.md — the Markdown file is
 * the single source of truth; the HTML is a standalone, offline-ready distribution copy.
 *
 * - ```mermaid fences are replaced by pre-rendered SVGs from docs/technical-report-assets/
 *   (fig-1.svg, fig-2.svg, ... in document order), with the mermaid source kept as a
 *   collapsible fallback. GitHub renders the fences natively; the standalone HTML must
 *   not depend on a CDN runtime.
 * - The paragraph immediately following a figure, when it starts with "图 N", becomes the
 *   figcaption. Blockquotes whose bold lead-in starts with 教训 become lesson callouts.
 * - A TOC is generated from h2 headings.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { marked } from "marked";

const root = fileURLToPath(new URL("..", import.meta.url));
const mdPath = join(root, "docs", "technical-report.md");
const outPath = join(root, "docs", "technical-report.html");
const assets = join(root, "docs", "technical-report-assets");
const css = readFileSync(join(root, "tools", "report-style.css"), "utf8");

let md = readFileSync(mdPath, "utf8");

// Pull mermaid fences out before markdown rendering; they return as figures.
const mermaids: string[] = [];
md = md.replace(/```mermaid\n([\s\S]*?)```/g, (_match, source: string) => {
  mermaids.push(source.trim());
  return `<!--MERMAID-${mermaids.length - 1}-->`;
});

marked.setOptions({ gfm: true });
let html = marked.parse(md) as string;

// Figures: placeholder + following 图-N paragraph -> <figure> with SVG and caption.
html = html.replace(
  /<!--MERMAID-(\d+)-->\s*(<p><strong>Figure \d+<\/strong>[\s\S]*?<\/p>)?/g,
  (_match, index: string, caption?: string) => {
    const figure = Number(index);
    const svgPath = join(assets, `fig-${figure + 1}.svg`);
    const media = existsSync(svgPath)
      ? `<div class="svgfig">${readFileSync(svgPath, "utf8")}</div>`
      : `<pre class="mermaid">${escapeHtml(mermaids[figure] ?? "")}</pre>`;
    const cap = caption
      ? `<figcaption>${caption.replace(/^<p>/, "").replace(/<\/p>$/, "").replace(/<strong>(Figure \d+)<\/strong>/, "<b>$1</b>")}</figcaption>`
      : "";
    return `<figure class="figure"><div class="frame">${media}` +
      `<details class="figsrc"><summary>Mermaid source</summary><pre>${escapeHtml(mermaids[figure] ?? "")}</pre></details>` +
      `</div>${cap}</figure>`;
  },
);

// Lesson blockquotes -> callouts.
html = html.replace(
  /<blockquote>\s*<p><strong>(Lesson[^<]*)<\/strong>([\s\S]*?)<\/p>\s*<\/blockquote>/g,
  '<div class="callout lesson"><span class="tag">$1</span>$2</div>',
);

// Tables scroll inside their own frame.
html = html.replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, "</table></div>");

// Heading anchors + TOC from h2s.
const toc: { id: string; label: string; no: string }[] = [];
html = html.replace(/<h2>([\s\S]*?)<\/h2>/g, (_match, inner: string) => {
  const text = inner.replace(/<[^>]+>/g, "");
  const numbered = /^(\d+)\s+(.*)$/.exec(text);
  const appendix = /^(Appendix [A-Z])[　 ]?(.*)$/.exec(text);
  let id: string;
  let no: string;
  let label: string;
  if (numbered) {
    id = `s${numbered[1]}`;
    no = numbered[1] as string;
    label = numbered[2] as string;
    tocPush(toc, id, no, label);
    return `<h2 id="${id}"><span class="no">${no}</span>${label}</h2>`;
  }
  if (appendix) {
    id = `appendix-${(appendix[1] as string).slice(-1).toLowerCase()}`;
    no = appendix[1] as string;
    label = appendix[2] as string;
    tocPush(toc, id, no, label);
    return `<h2 id="${id}"><span class="no">${no}</span>${label}</h2>`;
  }
  id = text === "Abstract" ? "abstract" : text === "References" ? "references" : `sec-${toc.length}`;
  tocPush(toc, id, "", text);
  return `<h2 id="${id}">${inner}</h2>`;
});

function tocPush(list: typeof toc, id: string, no: string, label: string): void {
  list.push({ id, no, label });
}

const tocHtml = `<nav aria-label="Contents"><h2 style="border:0; padding-top:0; margin-top:1.4rem;">Contents</h2><ul class="toc">` +
  toc.filter(entry => entry.id !== "abstract")
    .map(entry => `<li>${entry.no ? `<span class="no">${entry.no}</span>` : ""}<a href="#${entry.id}">${entry.label}</a></li>`)
    .join("") +
  `</ul></nav>`;

// Place the TOC after the abstract's keyword line (the paragraph starting 关键词).
html = html.replace(/(<p>Keywords:[\s\S]*?<\/p>)/, `$1\n${tocHtml}`);

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const title = /^# (.+)$/m.exec(md)?.[1]?.replace(/\*/g, "") ?? "VoxStudio Technical Report";
const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
<main class="paper">
<p class="kicker">Technical Report</p>
${html}
</main>
</body>
</html>
`;
writeFileSync(outPath, page);
console.error(`technical-report.html: ${page.length} bytes, ${mermaids.length} figures, ${toc.length} TOC entries`);
