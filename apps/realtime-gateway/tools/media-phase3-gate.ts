#!/usr/bin/env bun
import { dirname, resolve } from "node:path";
import {
  evaluatePhase3Acceptance,
  parsePhase3BillingEvidence,
  parsePhase3Manifest,
  parsePhase3NetworkEvidence,
  type Phase3TraceDocument,
} from "../src/media-phase3-acceptance";

function usage(): string {
  return [
    "Usage: bun run gate:media-phase3 -- --manifest <manifest.json> [--output <report.json>]",
    "",
    "The manifest references WebRTC media traces and external network evidence relative to itself.",
    "LiveKit Cloud manifests also reference one isolated-project billing export.",
    "The command exits 0 only when every run and the complete Phase 3 matrix pass.",
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
    const source = await file.text();
    return {
      value: JSON.parse(source) as unknown,
      digestSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
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
  const manifest = parsePhase3Manifest((await jsonDocument(manifestPath)).value);
  const base = dirname(manifestPath);
  const traces = new Map<string, Phase3TraceDocument>();
  const evidence = new Map();
  for (const run of manifest.runs) {
    traces.set(run.id, await jsonDocument(resolve(base, run.trace)));
    const document = await jsonDocument(resolve(base, run.networkEvidence));
    evidence.set(run.id, parsePhase3NetworkEvidence(document.value, document.digestSha256));
  }
  const billing = manifest.billingEvidence === undefined
    ? undefined
    : await jsonDocument(resolve(base, manifest.billingEvidence)).then(document =>
      parsePhase3BillingEvidence(document.value, document.digestSha256));
  const report = evaluatePhase3Acceptance(manifest, traces, evidence, billing);
  const outputArgument = option(args, "--output");
  const outputPath = resolve(outputArgument ?? manifestPath.replace(/\.json$/i, "") + ".report.json");
  await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Phase 3 WebRTC gate: ${report.passed ? "PASS" : "FAIL"}`);
  console.log(`deployment ${report.deployment}; runs ${report.summary.passedRuns}/${report.summary.runs}; failed checks ${report.summary.failedChecks}`);
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
