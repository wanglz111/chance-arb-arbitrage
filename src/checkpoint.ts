import fs from "node:fs";
import path from "node:path";

type BackfillCheckpoint = {
  fromBlock: number;
  mode: "blocks" | "logs";
  nextBlock: number;
  toBlock: number;
  updatedAt: string;
};

type CheckpointState = {
  backfills?: Record<string, BackfillCheckpoint>;
  live?: {
    blockPollNextBlock?: number;
    wsSyncedBlock?: number;
  };
};

function emptyState(): CheckpointState {
  return {
    backfills: {},
    live: {}
  };
}

export class CheckpointStore {
  private state: CheckpointState | null = null;

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  public getBlockPollNextBlock(): number | null {
    return this.getState().live?.blockPollNextBlock ?? null;
  }

  public setBlockPollNextBlock(nextBlock: number): void {
    const state = this.getState();
    state.live ??= {};
    state.live.blockPollNextBlock = nextBlock;
    this.persist(state);
  }

  public getWsSyncedBlock(): number | null {
    return this.getState().live?.wsSyncedBlock ?? null;
  }

  public setWsSyncedBlock(blockNumber: number): void {
    const state = this.getState();
    state.live ??= {};
    state.live.wsSyncedBlock = blockNumber;
    this.persist(state);
  }

  public getBackfillCursor(key: string): BackfillCheckpoint | null {
    return this.getState().backfills?.[key] ?? null;
  }

  public setBackfillCursor(
    key: string,
    value: {
      fromBlock: number;
      mode: "blocks" | "logs";
      nextBlock: number;
      toBlock: number;
    }
  ): void {
    const state = this.getState();
    state.backfills ??= {};
    state.backfills[key] = {
      ...value,
      updatedAt: new Date().toISOString()
    };
    this.persist(state);
  }

  public clearBackfillCursor(key: string): void {
    const state = this.getState();
    if (!state.backfills?.[key]) return;
    delete state.backfills[key];
    this.persist(state);
  }

  private getState(): CheckpointState {
    if (this.state) {
      return this.state;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.state = JSON.parse(raw) as CheckpointState;
      return this.state;
    } catch {
      this.state = emptyState();
      return this.state;
    }
  }

  private persist(state: CheckpointState): void {
    this.state = state;
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }
}
