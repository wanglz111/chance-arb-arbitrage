import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { logError, logInfo, logWarn } from "../src/logger.js";
import type { Candidate } from "../src/types.js";

type CountItem = {
  count: number;
  value: string;
};

type DatasetSummary = {
  averageScore: number;
  flashLoanCandidates: number;
  highestScore: number;
  latestTimestamp: number | null;
  payoutCandidates: number;
  protocols: CountItem[];
  routeHints: CountItem[];
  tags: CountItem[];
  totalCandidates: number;
};

type Dataset = {
  availableDays: string[];
  candidates: Candidate[];
  dataPath: string;
  selectedDate: string | null;
  invalidLineCount: number;
  mtimeMs: number;
  summary: DatasetSummary;
  updatedAt: string | null;
};

type CandidateQuery = {
  flashLoanOnly: boolean;
  limit: number;
  minScore: number;
  offset: number;
  payoutOnly: boolean;
  protocol: string;
  q: string;
  routeHint: string;
  sort: "newest" | "oldest" | "score-desc" | "score-asc";
  tag: string;
};

const projectRoot = process.cwd();
const viewerDir = path.resolve(projectRoot, "viewer");
const dataPath = path.resolve(projectRoot, process.argv[2] ?? process.env.CANDIDATES_PATH ?? "./data/candidates.jsonl");
const dataDir = path.dirname(dataPath);
const port = Number.parseInt(process.env.VIEWER_PORT ?? "4310", 10);
const host = process.env.VIEWER_HOST?.trim() || "127.0.0.1";

let cache: Dataset | null = null;

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function countValues(values: string[]): CountItem[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([value, count]) => ({ count, value }))
    .sort((left, right) => {
      if (left.count === right.count) {
        return left.value.localeCompare(right.value);
      }
      return right.count - left.count;
    });
}

function buildSummary(candidates: Candidate[]): DatasetSummary {
  const totalScore = candidates.reduce((sum, candidate) => sum + candidate.score, 0);

  return {
    averageScore: candidates.length === 0 ? 0 : totalScore / candidates.length,
    flashLoanCandidates: candidates.filter((candidate) => candidate.flashLoans.length > 0).length,
    highestScore: candidates.reduce((max, candidate) => Math.max(max, candidate.score), 0),
    latestTimestamp: candidates.reduce((max, candidate) => Math.max(max, candidate.timestamp), 0) || null,
    payoutCandidates: candidates.filter((candidate) => candidate.payouts.length > 0).length,
    protocols: countValues(candidates.flatMap((candidate) => candidate.protocols)),
    routeHints: countValues(candidates.flatMap((candidate) => candidate.routeHints)),
    tags: countValues(candidates.flatMap((candidate) => candidate.tags)),
    totalCandidates: candidates.length
  };
}

function candidatePathForDate(date: string): string {
  const parsed = path.parse(dataPath);
  return path.join(parsed.dir, `${parsed.name}-${date}${parsed.ext}`);
}

function candidateDateFromFileName(fileName: string): string | null {
  const parsed = path.parse(path.basename(dataPath));
  const escapedName = parsed.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedExt = parsed.ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fileName.match(new RegExp(`^${escapedName}-(\\d{4}-\\d{2}-\\d{2})${escapedExt}$`));
  if (!match) return null;
  return match[1] ?? null;
}

async function listAvailableDays(): Promise<string[]> {
  try {
    const entries = await fs.readdir(dataDir);
    return entries
      .map(candidateDateFromFileName)
      .filter((value): value is string => value !== null)
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}

async function resolveDatasetPath(requestedDate: string | null): Promise<{ availableDays: string[]; selectedDate: string | null; sourcePath: string }> {
  const availableDays = await listAvailableDays();
  const selectedDate = requestedDate ?? availableDays[0] ?? currentUtcDate();

  return {
    availableDays,
    selectedDate,
    sourcePath: candidatePathForDate(selectedDate)
  };
}

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadDataset(requestedDate: string | null): Promise<Dataset> {
  const resolved = await resolveDatasetPath(requestedDate);

  let stat;
  try {
    stat = await fs.stat(resolved.sourcePath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return {
        availableDays: resolved.availableDays,
        candidates: [],
        dataPath: resolved.sourcePath,
        invalidLineCount: 0,
        mtimeMs: -1,
        selectedDate: resolved.selectedDate,
        summary: buildSummary([]),
        updatedAt: null
      };
    }
    throw error;
  }

  if (cache && cache.dataPath === resolved.sourcePath && cache.mtimeMs === stat.mtimeMs) {
    cache.availableDays = resolved.availableDays;
    cache.selectedDate = resolved.selectedDate;
    return cache;
  }

  const raw = await fs.readFile(resolved.sourcePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const candidates: Candidate[] = [];
  let invalidLineCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      candidates.push(JSON.parse(trimmed) as Candidate);
    } catch {
      invalidLineCount += 1;
    }
  }

  candidates.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return right.blockNumber - left.blockNumber;
    }

    const leftIndex = left.txIndex ?? -1;
    const rightIndex = right.txIndex ?? -1;
    return rightIndex - leftIndex;
  });

  cache = {
    availableDays: resolved.availableDays,
    candidates,
    dataPath: resolved.sourcePath,
    invalidLineCount,
    mtimeMs: stat.mtimeMs,
    selectedDate: resolved.selectedDate,
    summary: buildSummary(candidates),
    updatedAt: new Date(stat.mtimeMs).toISOString()
  };

  return cache;
}

function parseBoolean(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function parseInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseQuery(url: URL): CandidateQuery {
  const sort = url.searchParams.get("sort");

  return {
    flashLoanOnly: parseBoolean(url.searchParams.get("flashLoanOnly")),
    limit: Math.max(1, Math.min(200, parseInteger(url.searchParams.get("limit"), 50))),
    minScore: Math.max(0, parseInteger(url.searchParams.get("minScore"), 0)),
    offset: Math.max(0, parseInteger(url.searchParams.get("offset"), 0)),
    payoutOnly: parseBoolean(url.searchParams.get("payoutOnly")),
    protocol: url.searchParams.get("protocol")?.trim() ?? "",
    q: url.searchParams.get("q")?.trim().toLowerCase() ?? "",
    routeHint: url.searchParams.get("routeHint")?.trim() ?? "",
    sort: (
      sort === "oldest"
      || sort === "score-desc"
      || sort === "score-asc"
    ) ? sort : "newest",
    tag: url.searchParams.get("tag")?.trim() ?? ""
  };
}

function parseDateParam(url: URL): string | null {
  const value = url.searchParams.get("date")?.trim();
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function candidateSearchText(candidate: Candidate): string {
  return [
    candidate.txHash,
    candidate.from,
    candidate.to ?? "",
    candidate.summary,
    candidate.tags.join(" "),
    candidate.protocols.join(" "),
    candidate.routeHints.join(" "),
    candidate.evidence.join(" "),
    candidate.flashLoans.map((item) => `${item.protocol} ${item.asset} ${item.callback} ${item.receiver ?? ""} ${item.caller ?? ""}`).join(" "),
    candidate.payouts.map((item) => `${item.recipient} ${item.token} ${item.netAmountWei}`).join(" ")
  ].join(" ").toLowerCase();
}

function filterCandidates(candidates: Candidate[], query: CandidateQuery): Candidate[] {
  const filtered = candidates.filter((candidate) => {
    if (query.tag && !candidate.tags.some((tag) => tag === query.tag)) return false;
    if (query.protocol && !candidate.protocols.includes(query.protocol)) return false;
    if (query.routeHint && !candidate.routeHints.includes(query.routeHint)) return false;
    if (query.flashLoanOnly && candidate.flashLoans.length === 0) return false;
    if (query.payoutOnly && candidate.payouts.length === 0) return false;
    if (query.minScore > 0 && candidate.score < query.minScore) return false;
    if (query.q && !candidateSearchText(candidate).includes(query.q)) return false;
    return true;
  });

  filtered.sort((left, right) => {
    if (query.sort === "oldest") {
      if (left.blockNumber !== right.blockNumber) return left.blockNumber - right.blockNumber;
      return (left.txIndex ?? -1) - (right.txIndex ?? -1);
    }

    if (query.sort === "score-desc") {
      if (left.score !== right.score) return right.score - left.score;
      if (left.blockNumber !== right.blockNumber) return right.blockNumber - left.blockNumber;
      return (right.txIndex ?? -1) - (left.txIndex ?? -1);
    }

    if (query.sort === "score-asc") {
      if (left.score !== right.score) return left.score - right.score;
      if (left.blockNumber !== right.blockNumber) return right.blockNumber - left.blockNumber;
      return (right.txIndex ?? -1) - (left.txIndex ?? -1);
    }

    if (left.blockNumber !== right.blockNumber) return right.blockNumber - left.blockNumber;
    return (right.txIndex ?? -1) - (left.txIndex ?? -1);
  });

  return filtered;
}

function sendJson(response: http.ServerResponse, payload: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function sendStaticFile(response: http.ServerResponse, filePath: string): Promise<void> {
  try {
    const contents = await fs.readFile(filePath);
    response.statusCode = 200;
    response.setHeader("content-type", contentTypeFor(filePath));
    response.end(contents);
  } catch {
    response.statusCode = 404;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("Not found");
  }
}

function sendError(response: http.ServerResponse, statusCode: number, message: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: message }));
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    sendError(response, 400, "Missing request URL");
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

  try {
    if (url.pathname === "/api/summary") {
      const dataset = await loadDataset(parseDateParam(url));
      sendJson(response, {
        availableDays: dataset.availableDays,
        dataPath: dataset.dataPath,
        invalidLineCount: dataset.invalidLineCount,
        selectedDate: dataset.selectedDate,
        summary: dataset.summary,
        updatedAt: dataset.updatedAt
      });
      return;
    }

    if (url.pathname === "/api/candidates") {
      const dataset = await loadDataset(parseDateParam(url));
      const query = parseQuery(url);
      const filtered = filterCandidates(dataset.candidates, query);
      const items = filtered.slice(query.offset, query.offset + query.limit);

      sendJson(response, {
        items,
        meta: {
          availableDays: dataset.availableDays,
          dataPath: dataset.dataPath,
          invalidLineCount: dataset.invalidLineCount,
          limit: query.limit,
          offset: query.offset,
          returned: items.length,
          selectedDate: dataset.selectedDate,
          total: filtered.length,
          updatedAt: dataset.updatedAt
        }
      });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      await sendStaticFile(response, path.join(viewerDir, "index.html"));
      return;
    }

    if (url.pathname === "/app.js") {
      await sendStaticFile(response, path.join(viewerDir, "app.js"));
      return;
    }

    if (url.pathname === "/styles.css") {
      await sendStaticFile(response, path.join(viewerDir, "styles.css"));
      return;
    }

    sendError(response, 404, "Not found");
  } catch (error) {
    logError(String(error instanceof Error ? error.stack ?? error.message : error));
    sendError(response, 500, "Internal server error");
  }
});

server.listen(port, host, () => {
  logInfo(`[viewer] candidates=${dataPath} dailyDir=${dataDir}`);
  logInfo(`[viewer] open http://${host}:${port}`);
});

server.on("error", (error) => {
  logWarn(`[viewer] server error ${String(error instanceof Error ? error.message : error)}`);
});
