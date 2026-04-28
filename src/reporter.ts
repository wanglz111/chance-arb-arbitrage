import fs from "node:fs";
import path from "node:path";

import type { Candidate } from "./types.js";
import { logInfo } from "./logger.js";
import { shortHash } from "./utils.js";

export class CandidateReporter {
  private readonly seenTxHashes = new Set<string>();

  constructor(private readonly outputPath: string) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    this.loadExistingCandidates();
  }

  public reportCandidate(candidate: Candidate): boolean {
    const txHash = candidate.txHash.toLowerCase();
    if (this.seenTxHashes.has(txHash)) {
      return false;
    }

    fs.appendFileSync(this.outputPath, `${JSON.stringify(candidate)}\n`);
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
    try {
      const raw = fs.readFileSync(this.outputPath, "utf8");
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
}
