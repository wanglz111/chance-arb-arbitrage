import fs from "node:fs";
import path from "node:path";

import type { Candidate } from "./types.js";
import { logInfo } from "./logger.js";
import { shortHash } from "./utils.js";

export class CandidateReporter {
  private readonly seenTxHashes = new Set<string>();
  private currentOutputPath: string | null = null;

  constructor(private readonly outputPath: string) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    this.loadExistingCandidates();
  }

  public reportCandidate(candidate: Candidate): boolean {
    const txHash = candidate.txHash.toLowerCase();
    if (this.seenTxHashes.has(txHash)) {
      return false;
    }

    const targetPath = this.outputPathForCandidate(candidate);
    if (targetPath !== this.currentOutputPath) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      this.currentOutputPath = targetPath;
      logInfo(`[candidate] output=${targetPath}`);
    }

    fs.appendFileSync(targetPath, `${JSON.stringify(candidate)}\n`);
    this.seenTxHashes.add(txHash);
    logInfo(
      `[candidate] block=${candidate.blockNumber} tx=${shortHash(candidate.txHash)} score=${candidate.score} tags=${candidate.tags.join(",")} ${candidate.summary}`
    );
    return true;
  }

  public reportBlockSummary(blockNumber: number, txCount: number, candidateCount: number): void {
    logInfo(`[block] number=${blockNumber} txs=${txCount} candidates=${candidateCount}`);
  }

  private loadExistingCandidates(): void {
    const candidateFiles = this.existingCandidateFiles();

    for (const candidateFile of candidateFiles) {
      this.loadCandidateFile(candidateFile);
    }
  }

  private loadCandidateFile(candidateFile: string): void {
    try {
      const raw = fs.readFileSync(candidateFile, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const candidate = JSON.parse(trimmed) as Candidate;
          if (candidate.txHash) {
            this.seenTxHashes.add(candidate.txHash.toLowerCase());
          }
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  }

  private existingCandidateFiles(): string[] {
    const directory = path.dirname(this.outputPath);
    const baseName = path.basename(this.outputPath);
    const parsed = path.parse(baseName);
    const datedPattern = new RegExp(`^${escapeRegExp(parsed.name)}-\\d{4}-\\d{2}-\\d{2}${escapeRegExp(parsed.ext)}$`);
    const files = new Set<string>();

    try {
      for (const entry of fs.readdirSync(directory)) {
        if (datedPattern.test(entry)) {
          files.add(path.join(directory, entry));
        }
      }
    } catch {
      return Array.from(files);
    }

    return Array.from(files);
  }

  private outputPathForCandidate(candidate: Candidate): string {
    const parsed = path.parse(this.outputPath);
    const day = utcDateString(candidate.timestamp);
    return path.join(parsed.dir, `${parsed.name}-${day}${parsed.ext}`);
  }
}

function utcDateString(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
