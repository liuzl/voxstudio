import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const dist = join(import.meta.dir, "..", "apps", "web", "dist");
const assets = join(dist, "assets");
const limits = {
  entryBytes: 300_000,
  eagerBytes: 500_000,
  panelBytes: 120_000,
  chunkBytes: 550_000,
} as const;

const html = await readFile(join(dist, "index.html"), "utf8");
const entryMatch = /<script[^>]+type="module"[^>]+src="\/([^"]+\.js)"/.exec(html);
if (!entryMatch?.[1]) throw new TypeError("web bundle: index.html has no module entry");

const eager = new Set<string>();
for (const match of html.matchAll(/(?:src|href)="\/([^"]+\.js)"/g)) {
  if (match[1]) eager.add(match[1]);
}

const chunks = (await readdir(assets))
  .filter(name => name.endsWith(".js"))
  .map(async name => ({ name, bytes: (await stat(join(assets, name))).size }));
const measured = await Promise.all(chunks);
const byPath = new Map(measured.map(chunk => [`assets/${chunk.name}`, chunk.bytes]));
const entryBytes = byPath.get(entryMatch[1]);
if (entryBytes === undefined) throw new TypeError(`web bundle: missing entry ${entryMatch[1]}`);
const eagerBytes = [...eager].reduce((total, path) => {
  const bytes = byPath.get(path);
  if (bytes === undefined) throw new TypeError(`web bundle: missing eager asset ${path}`);
  return total + bytes;
}, 0);

const failures: string[] = [];
if (entryBytes > limits.entryBytes) failures.push(`entry ${entryBytes} > ${limits.entryBytes}`);
if (eagerBytes > limits.eagerBytes) failures.push(`eager JS ${eagerBytes} > ${limits.eagerBytes}`);
for (const chunk of measured) {
  if (chunk.bytes > limits.chunkBytes) failures.push(`${chunk.name} ${chunk.bytes} > ${limits.chunkBytes}`);
  if (chunk.name.includes("Panel-") && chunk.bytes > limits.panelBytes) {
    failures.push(`${chunk.name} ${chunk.bytes} > panel budget ${limits.panelBytes}`);
  }
}

const largest = measured.sort((a, b) => b.bytes - a.bytes)[0];
const kb = (bytes: number): string => `${(bytes / 1_000).toFixed(1)} kB`;
console.log(
  `web-bundle: entry ${kb(entryBytes)}, eager ${kb(eagerBytes)}, ${measured.length} chunks,`
  + ` largest ${largest ? `${basename(largest.name)} ${kb(largest.bytes)}` : "none"}`,
);
if (failures.length > 0) throw new TypeError(`web bundle budget exceeded:\n- ${failures.join("\n- ")}`);
