#!/usr/bin/env bun
import { dirname, resolve } from "node:path";
import {
  evaluatePhase2Acceptance,
  parsePhase2Manifest,
  parsePhase2NetworkEvidence,
  type Phase2TraceDocument,
} from "../src/media-phase2-acceptance";

function usage(): string {
  return [
    "Usage: bun run gate:media-phase2 -- --manifest <manifest.json> [--output <report.json>]",
    "",
    "The manifest references browser media traces and external network evidence relative to itself.",
    "The command exits 0 only when every run and the complete Phase 2 matrix pass.",
  ].join("\n");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`${name} requires a value`);
  return value;
}

async function jsonDocument(path: string): Promise<{ value: unknown; digestSha256: string }> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new TypeError(`file not found: ${path}`);
  try {
    const text = await file.text();
    return {
      value: JSON.parse(text) as unknown,
      digestSha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    };
  } catch (error) {
    throw new TypeError(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  const args = Bun.argv.slice(2).filter(argument => argument !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const manifestArgument = option(args, "--manifest") ?? args.find(argument => !argument.startsWith("--"));
  if (manifestArgument === undefined) throw new TypeError("--manifest is required");
  const manifestPath = resolve(manifestArgument);
  const manifest = parsePhase2Manifest((await jsonDocument(manifestPath)).value);
  const base = dirname(manifestPath);
  const traces = new Map<string, Phase2TraceDocument>();
  const evidence = new Map();
  for (const run of manifest.runs) {
    traces.set(run.id, await jsonDocument(resolve(base, run.trace)));
    const document = await jsonDocument(resolve(base, run.networkEvidence));
    evidence.set(run.id, parsePhase2NetworkEvidence(document.value, document.digestSha256));
  }
  const report = evaluatePhase2Acceptance(manifest, traces, evidence);
  const outputArgument = option(args, "--output");
  const outputPath = resolve(outputArgument ?? manifestPath.replace(/\.json$/i, "") + ".report.json");
  await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Phase 2 media gate: ${report.passed ? "PASS" : "FAIL"}`);
  console.log(`runs ${report.summary.passedRuns}/${report.summary.runs}; failed checks ${report.summary.failedChecks}`);
  console.log(`report ${outputPath}`);
  if (!report.passed) {
    for (const candidate of report.matrix.filter(check => !check.passed)) {
      console.error(`FAIL ${candidate.id}: expected ${JSON.stringify(candidate.expected)}, got ${JSON.stringify(candidate.actual)}`);
    }
    for (const run of report.runs) {
      for (const candidate of run.checks.filter(check => !check.passed)) {
        console.error(`FAIL ${run.id}/${candidate.id}: expected ${JSON.stringify(candidate.expected)}, got ${JSON.stringify(candidate.actual)}`);
      }
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 2;
}
