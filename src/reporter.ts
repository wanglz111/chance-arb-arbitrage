import fs from "node:fs";
import path from "node:path";

import type { Candidate } from "./types.js";
import { logInfo } from "./logger.js";
import { shortHash } from "./utils.js";

export class CandidateReporter {
  constructor(private readonly outputPath: string) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }

  public reportCandidate(candidate: Candidate): void {
    fs.appendFileSync(this.outputPath, `${JSON.stringify(candidate)}\n`);
    logInfo(
      `[candidate] block=${candidate.blockNumber} tx=${shortHash(candidate.txHash)} score=${candidate.score} tags=${candidate.tags.join(",")} ${candidate.summary}`
    );
  }

  public reportBlockSummary(blockNumber: number, txCount: number, candidateCount: number): void {
    logInfo(`[block] number=${blockNumber} txs=${txCount} candidates=${candidateCount}`);
  }
}
