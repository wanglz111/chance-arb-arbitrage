import fs from "node:fs";
import path from "node:path";

import type { Candidate } from "../src/types.js";
import { shortHash } from "../src/utils.js";

type CountItem = {
  count: number;
  key: string;
  scoreTotal: number;
};

type PatternCandidate = {
  blockNumber: number;
  evidence: string[];
  flashLoanAmountWei: string;
  flashLoanProtocols: string[];
  gasUsedWei: string;
  payoutTokens: string[];
  payoutWeiTotal: string;
  protocols: string[];
  routeHints: string[];
  score: number;
  tags: string[];
  target: string | null;
  txHash: string;
};

type PatternReport = {
  averageScore: number;
  candidates: PatternCandidate[];
  count: number;
  key: string;
  maxScore: number;
  totalPayoutWei: string;
};

type AnalysisReport = {
  generatedAt: string;
  inputPath: string;
  invalidLineCount: number;
  notes: string[];
  parameters: {
    minScore: number;
    sinceHours: number | null;
    top: number;
  };
  patterns: {
    flashPaths: PatternReport[];
    protocolCombinations: PatternReport[];
    routeHints: PatternReport[];
    tagCombinations: PatternReport[];
    targetContracts: PatternReport[];
  };
  summary: {
    filteredCandidates: number;
    flashLoanCandidates: number;
    payoutCandidates: number;
    validRows: number;
  };
  topCandidates: PatternCandidate[];
};

type ParsedArgs = {
  inputPath: string;
  minScore: number;
  reportPath: string;
  sinceHours: number | null;
  top: number;
};

type LoadedCandidates = {
  candidates: Candidate[];
  invalidLineCount: number;
};

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function parseArgs(argv: string[]): ParsedArgs {
  let inputPath = "./data/candidates.jsonl";
  let minScore = 0;
  let reportPath = "./data/candidate-analysis-report.json";
  let sinceHours: number | null = null;
  let top = 15;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--min-score") {
      minScore = parseInteger(argv[index + 1], minScore);
      index += 1;
      continue;
    }
    if (arg === "--since-hours") {
      sinceHours = parseInteger(argv[index + 1], 24);
      index += 1;
      continue;
    }
    if (arg === "--top") {
      top = Math.max(1, parseInteger(argv[index + 1], top));
      index += 1;
      continue;
    }
    if (arg === "--report") {
      reportPath = argv[index + 1] ?? reportPath;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      inputPath = arg;
    }
  }

  return {
    inputPath: isHttpUrl(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath),
    minScore,
    reportPath: path.resolve(process.cwd(), reportPath),
    sinceHours,
    top
  };
}

function printUsage(): void {
  console.log(`Usage: npm run analyze:candidates -- [path-or-url] [--since-hours 24] [--min-score 7] [--top 20] [--report path]

Examples:
  npm run analyze:candidates
  npm run analyze:candidates -- ./data/candidates-24h.jsonl --since-hours 24 --min-score 6 --report ./data/report-24h.json
  npm run analyze:candidates -- https://arb-chance.gleaftex.com/candidates/candidates-2026-04-28.jsonl --min-score 6
`);
}

async function readCandidateInput(inputPath: string): Promise<string> {
  if (!isHttpUrl(inputPath)) {
    return fs.readFileSync(inputPath, "utf8");
  }

  const response = await fetch(inputPath);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${inputPath}: HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function loadCandidates(inputPath: string): Promise<LoadedCandidates> {
  const raw = await readCandidateInput(inputPath);
  const candidates: Candidate[] = [];
  let invalidLineCount = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      candidates.push(JSON.parse(trimmed) as Candidate);
    } catch {
      invalidLineCount += 1;
    }
  }

  return { candidates, invalidLineCount };
}

function keyOrDash(values: readonly string[]): string {
  return values.length === 0 ? "-" : [...values].sort().join(" + ");
}

function flashPathKey(candidate: Candidate): string {
  if (candidate.flashLoans.length === 0) return "no-flash-loan";

  const providers = keyOrDash(candidate.flashLoans.map((item) => item.protocol));
  const callbacks = keyOrDash(candidate.flashLoans.map((item) => item.callback));
  const downstream = [
    candidate.metrics.swapPools > 0 ? "swap" : null,
    candidate.metrics.swapPools >= 2 ? "multi-pool" : null,
    candidate.routeHints.some((hint) => hint.includes("repay/withdraw")) ? "repay/withdraw" : null,
    candidate.payouts.length > 0 ? "payout" : null
  ].filter((value): value is string => value !== null);

  return `${providers} -> ${callbacks}${downstream.length > 0 ? ` -> ${downstream.join(" -> ")}` : ""}`;
}

function increment(map: Map<string, CountItem>, key: string, score: number): void {
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.scoreTotal += score;
    return;
  }

  map.set(key, { count: 1, key, scoreTotal: score });
}

function topItems(map: Map<string, CountItem>, limit: number): CountItem[] {
  return Array.from(map.values())
    .sort((left, right) => {
      if (left.count === right.count) {
        const leftAvg = left.scoreTotal / left.count;
        const rightAvg = right.scoreTotal / right.count;
        if (leftAvg === rightAvg) return left.key.localeCompare(right.key);
        return rightAvg - leftAvg;
      }
      return right.count - left.count;
    })
    .slice(0, limit);
}

function formatEtherLikeWei(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000_000_000_000_000n;
  const fraction = amount % 1_000_000_000_000_000_000n;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return fractionText ? `${whole.toString()}.${fractionText}` : whole.toString();
}

function sumStringBigInts(values: string[]): string {
  return values.reduce((sum, value) => sum + BigInt(value), 0n).toString();
}

function toPatternCandidate(candidate: Candidate): PatternCandidate {
  return {
    blockNumber: candidate.blockNumber,
    evidence: candidate.evidence.slice(0, 8),
    flashLoanAmountWei: candidate.metrics.flashLoanAmountWei,
    flashLoanProtocols: [...new Set(candidate.flashLoans.map((item) => item.protocol))].sort(),
    gasUsedWei: candidate.gasUsedWei,
    payoutTokens: [...new Set(candidate.payouts.map((item) => item.token))].sort(),
    payoutWeiTotal: sumStringBigInts(candidate.payouts.map((item) => item.netAmountWei)),
    protocols: candidate.protocols,
    routeHints: candidate.routeHints,
    score: candidate.score,
    tags: candidate.tags,
    target: candidate.to,
    txHash: candidate.txHash
  };
}

function sortCandidatesByScore(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.blockNumber !== right.blockNumber) return right.blockNumber - left.blockNumber;
    return (right.txIndex ?? -1) - (left.txIndex ?? -1);
  });
}

function buildPatternReports(
  candidates: Candidate[],
  keyForCandidate: (candidate: Candidate) => string | string[],
  limit: number,
  sampleLimit: number
): PatternReport[] {
  const grouped = new Map<string, Candidate[]>();

  for (const candidate of candidates) {
    const keys = keyForCandidate(candidate);
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const existing = grouped.get(key);
      if (existing) {
        existing.push(candidate);
      } else {
        grouped.set(key, [candidate]);
      }
    }
  }

  return Array.from(grouped.entries())
    .map(([key, values]) => {
      const sorted = sortCandidatesByScore(values);
      const scoreTotal = values.reduce((sum, candidate) => sum + candidate.score, 0);
      return {
        averageScore: values.length === 0 ? 0 : scoreTotal / values.length,
        candidates: sorted.slice(0, sampleLimit).map(toPatternCandidate),
        count: values.length,
        key,
        maxScore: sorted[0]?.score ?? 0,
        totalPayoutWei: sumStringBigInts(values.flatMap((candidate) => (
          candidate.payouts.map((payout) => payout.netAmountWei)
        )))
      };
    })
    .sort((left, right) => {
      if (left.count !== right.count) return right.count - left.count;
      if (left.averageScore !== right.averageScore) return right.averageScore - left.averageScore;
      return left.key.localeCompare(right.key);
    })
    .slice(0, limit);
}

function writeReport(args: ParsedArgs, loaded: LoadedCandidates, candidates: Candidate[], flashLoanCount: number, payoutCount: number): AnalysisReport {
  const sortedByScore = sortCandidatesByScore(candidates);
  const report: AnalysisReport = {
    generatedAt: new Date().toISOString(),
    inputPath: args.inputPath,
    invalidLineCount: loaded.invalidLineCount,
    notes: [
      "This report is optimized for follow-up review by Codex.",
      "Patterns are discovery signals, not profit proof.",
      "Use repeated high-score paths with payout evidence as the first copy/replay candidates."
    ],
    parameters: {
      minScore: args.minScore,
      sinceHours: args.sinceHours,
      top: args.top
    },
    patterns: {
      flashPaths: buildPatternReports(candidates, flashPathKey, args.top, 5),
      protocolCombinations: buildPatternReports(candidates, (candidate) => keyOrDash(candidate.protocols), args.top, 5),
      routeHints: buildPatternReports(candidates, (candidate) => candidate.routeHints.length > 0 ? candidate.routeHints : ["-"], args.top, 5),
      tagCombinations: buildPatternReports(candidates, (candidate) => keyOrDash(candidate.tags), args.top, 5),
      targetContracts: buildPatternReports(candidates, (candidate) => candidate.to ?? "contract-create", args.top, 5)
    },
    summary: {
      filteredCandidates: candidates.length,
      flashLoanCandidates: flashLoanCount,
      payoutCandidates: payoutCount,
      validRows: loaded.candidates.length
    },
    topCandidates: sortedByScore.slice(0, args.top).map(toPatternCandidate)
  };

  fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
  fs.writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function printCountSection(title: string, items: CountItem[]): void {
  console.log(`\n${title}`);
  if (items.length === 0) {
    console.log("  -");
    return;
  }

  for (const item of items) {
    const averageScore = item.scoreTotal / item.count;
    console.log(`  ${String(item.count).padStart(4, " ")}  avgScore=${averageScore.toFixed(2)}  ${item.key}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadCandidates(args.inputPath);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const minTimestamp = args.sinceHours === null ? null : nowSeconds - (args.sinceHours * 60 * 60);

  const candidates = loaded.candidates.filter((candidate) => (
    candidate.score >= args.minScore
    && (minTimestamp === null || candidate.timestamp >= minTimestamp)
  ));

  const byTagCombo = new Map<string, CountItem>();
  const byProtocolCombo = new Map<string, CountItem>();
  const byRouteHint = new Map<string, CountItem>();
  const byFlashPath = new Map<string, CountItem>();
  const byTarget = new Map<string, CountItem>();

  let flashLoanCount = 0;
  let payoutCount = 0;

  for (const candidate of candidates) {
    if (candidate.flashLoans.length > 0) flashLoanCount += 1;
    if (candidate.payouts.length > 0) payoutCount += 1;

    increment(byTagCombo, keyOrDash(candidate.tags), candidate.score);
    increment(byProtocolCombo, keyOrDash(candidate.protocols), candidate.score);
    increment(byFlashPath, flashPathKey(candidate), candidate.score);
    increment(byTarget, candidate.to ?? "contract-create", candidate.score);

    for (const hint of candidate.routeHints) {
      increment(byRouteHint, hint, candidate.score);
    }
  }

  const sortedByScore = sortCandidatesByScore(candidates);
  const report = writeReport(args, loaded, candidates, flashLoanCount, payoutCount);

  console.log(`Input: ${args.inputPath}`);
  console.log(`Report: ${args.reportPath}`);
  console.log(`Rows: ${loaded.candidates.length} valid, ${loaded.invalidLineCount} invalid`);
  console.log(`Filtered: ${candidates.length} candidates, minScore=${args.minScore}, sinceHours=${args.sinceHours ?? "all"}`);
  console.log(`Flash loan candidates: ${flashLoanCount}`);
  console.log(`Payout candidates: ${payoutCount}`);
  console.log(`Structured patterns: flashPaths=${report.patterns.flashPaths.length}, routeHints=${report.patterns.routeHints.length}, topCandidates=${report.topCandidates.length}`);

  printCountSection("Common flash paths", topItems(byFlashPath, args.top));
  printCountSection("Common route hints", topItems(byRouteHint, args.top));
  printCountSection("Protocol combinations", topItems(byProtocolCombo, args.top));
  printCountSection("Tag combinations", topItems(byTagCombo, args.top));
  printCountSection("Target contracts", topItems(byTarget, args.top));

  console.log("\nHighest score samples");
  for (const candidate of sortedByScore.slice(0, args.top)) {
    const flashWei = formatEtherLikeWei(candidate.metrics.flashLoanAmountWei);
    console.log(
      `  score=${candidate.score} block=${candidate.blockNumber} tx=${shortHash(candidate.txHash)} flashWei=${flashWei} tags=${candidate.tags.join(",")} path=${flashPathKey(candidate)}`
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
