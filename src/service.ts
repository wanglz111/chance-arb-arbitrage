import type { Log, WebSocketLike } from "ethers";
import { WebSocketProvider } from "ethers";

import { classifyTransaction } from "./classifier.js";
import { CheckpointStore } from "./checkpoint.js";
import { AAVE_V3_POOL_ADDRESS, BALANCER_V2_VAULT_ADDRESS, TOPICS } from "./constants.js";
import { ChainFetcher } from "./fetcher.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { CandidateReporter } from "./reporter.js";
import type { AppConfig, BackfillMode, Candidate, RawReceipt, UniswapV3PoolSnapshot } from "./types.js";
import { mapWithConcurrency, normalizeAddress, shortHash, sleep } from "./utils.js";

type ManagedWebSocket = WebSocketLike & {
  onclose?: null | ((event: { code?: number; reason?: string } | unknown) => unknown);
};

type FlashLoanSignalSubscription = {
  filter: {
    address?: string;
    topics: string[];
  };
  label: string;
};

export class CandidateDiscoveryService {
  private readonly checkpoints: CheckpointStore;
  private readonly fetcher: ChainFetcher;
  private readonly reporter: CandidateReporter;
  private readonly seenSignalTxs = new Map<string, number>();
  private readonly signalTxsInFlight = new Set<string>();

  private wsProvider: WebSocketProvider | null = null;
  private stopWsCheckpointLoop: (() => void) | null = null;

  constructor(private readonly config: AppConfig) {
    this.checkpoints = new CheckpointStore(config.checkpointPath);
    this.fetcher = new ChainFetcher(config.rpcUrl, config.maxConcurrentTransactions);
    this.reporter = new CandidateReporter(config.outputPath);
  }

  public async destroy(): Promise<void> {
    if (this.stopWsCheckpointLoop) {
      this.stopWsCheckpointLoop();
      this.stopWsCheckpointLoop = null;
    }

    if (this.wsProvider) {
      await this.wsProvider.destroy();
      this.wsProvider = null;
    }
    await this.fetcher.destroy();
  }

  public async run(): Promise<void> {
    if (this.config.liveMode === "ws-flashloan") {
      await this.runFlashLoanSignals();
      return;
    }

    await this.runLive();
  }

  public async analyzeTransactionHash(hash: string): Promise<Candidate | null> {
    const [tx, receipt] = await Promise.all([
      this.fetcher.getTransaction(hash),
      this.fetcher.getReceipt(hash)
    ]);

    if (!tx || !receipt) {
      return null;
    }

    const blockNumber = Number.parseInt(receipt.blockNumber, 16);
    const timestamp = await this.fetcher.getBlockTimestamp(blockNumber) ?? Math.floor(Date.now() / 1000);
    const uniswapV3PoolsByAddress = await this.buildUniswapV3PoolSnapshotMap(receipt);

    return classifyTransaction({
      config: this.config,
      receipt,
      timestamp,
      tx,
      uniswapV3PoolsByAddress
    });
  }

  public async scanBlock(blockNumber: number): Promise<Candidate[]> {
    const bundle = await this.fetcher.getBlockBundle(blockNumber);
    if (!bundle.block) {
      logWarn(`[scan] block not found number=${blockNumber}`);
      return [];
    }

    const timestamp = Number.parseInt(bundle.block.timestamp, 16);
    const candidates = await mapWithConcurrency(
      bundle.block.transactions,
      this.config.maxConcurrentTransactions,
      async (tx) => {
        const receipt = bundle.receiptsByHash.get(tx.hash.toLowerCase());
        if (!receipt) return null;
        const uniswapV3PoolsByAddress = await this.buildUniswapV3PoolSnapshotMap(receipt);

        return classifyTransaction({
          config: this.config,
          receipt,
          timestamp,
          tx,
          uniswapV3PoolsByAddress
        });
      }
    );

    const filtered = candidates.filter((candidate): candidate is Candidate => candidate !== null);
    let reportedCount = 0;
    for (const candidate of filtered) {
      if (this.reporter.reportCandidate(candidate)) {
        reportedCount += 1;
      }
    }
    this.reporter.reportBlockSummary(blockNumber, bundle.block.transactions.length, reportedCount);
    return filtered;
  }

  public async scanRange(fromBlock: number, toBlock: number): Promise<void> {
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      await this.scanBlock(blockNumber);
    }
  }

  public async backfillRange(fromBlock: number, toBlock: number, mode: BackfillMode, resume: boolean): Promise<void> {
    if (mode === "logs") {
      await this.backfillRangeByLogs(fromBlock, toBlock, resume);
      return;
    }

    await this.backfillRangeByBlocks(fromBlock, toBlock, resume);
  }

  public async runLive(): Promise<void> {
    let nextBlock = this.config.startBlock;
    const checkpointBlock = this.checkpoints.getBlockPollNextBlock();

    if (checkpointBlock !== null) {
      nextBlock = nextBlock === null ? checkpointBlock : Math.max(nextBlock, checkpointBlock);
    }

    if (nextBlock === null) {
      const latest = await this.fetcher.getLatestBlockNumber();
      nextBlock = Math.max(0, latest - this.config.finalityConfirmations);
      this.checkpoints.setBlockPollNextBlock(nextBlock);
    }

    logInfo(
      `[live] mode=block-poll chain=${this.config.chainName} nextBlock=${nextBlock} confirmations=${this.config.finalityConfirmations} pollMs=${this.config.pollIntervalMs}`
    );

    while (true) {
      const latest = await this.fetcher.getLatestBlockNumber();
      const targetBlock = Math.max(0, latest - this.config.finalityConfirmations);

      while (nextBlock <= targetBlock) {
        await this.scanBlock(nextBlock);
        nextBlock += 1;
        this.checkpoints.setBlockPollNextBlock(nextBlock);
      }

      await sleep(this.config.pollIntervalMs);
    }
  }

  public async runFlashLoanSignals(): Promise<void> {
    if (!this.config.wsRpcUrl) {
      throw new Error("WS_RPC_URL is required for ws-flashloan mode");
    }

    const subscriptions = this.getFlashLoanSignalSubscriptions();
    logInfo(
      `[live] mode=ws-flashloan chain=${this.config.chainName} confirmations=${this.config.finalityConfirmations} checkpointIntervalMs=${this.config.wsCheckpointIntervalMs} reconnectMs=${this.config.wsReconnectDelayMs} dedupMs=${this.config.wsSignalDedupMs} signals=${subscriptions.map((item) => item.label).join(",")}`
    );

    while (true) {
      let closeReason = "unknown";

      try {
        const provider = new WebSocketProvider(this.config.wsRpcUrl, undefined, { staticNetwork: true });
        this.wsProvider = provider;

        const closePromise = new Promise<void>((resolve) => {
          const socket = provider.websocket as ManagedWebSocket;
          socket.onclose = (event) => {
            closeReason = typeof event === "object" && event !== null
              ? `code=${String("code" in event ? event.code : "unknown")} reason=${String("reason" in event ? event.reason : "")}`
              : "unknown";
            resolve();
          };
        });

        await provider.getNetwork();
        await this.skipToLatestFlashLoanSignals();
        this.stopWsCheckpointLoop = this.startWsCheckpointLoop();

        for (const subscription of subscriptions) {
          provider.on(subscription.filter, (log) => {
            void this.handleFlashLoanSignal(subscription.label, log as Log);
          });
        }

        logInfo(`[ws] connected and subscribed url=${this.redactWsUrl(this.config.wsRpcUrl)}`);
        await closePromise;
        logWarn(`[ws] disconnected ${closeReason}`);
      } catch (error) {
        logError(String(error instanceof Error ? error.stack ?? error.message : error));
      } finally {
        if (this.stopWsCheckpointLoop) {
          this.stopWsCheckpointLoop();
          this.stopWsCheckpointLoop = null;
        }

        if (this.wsProvider) {
          await this.wsProvider.destroy().catch(() => undefined);
          this.wsProvider = null;
        }
      }

      logInfo(`[ws] reconnecting in ${this.config.wsReconnectDelayMs}ms`);
      await sleep(this.config.wsReconnectDelayMs);
    }
  }

  private getFlashLoanSignalSubscriptions(): FlashLoanSignalSubscription[] {
    return [
      {
        filter: {
          address: AAVE_V3_POOL_ADDRESS,
          topics: [TOPICS.aaveFlashLoan]
        },
        label: "aave-v3-flash-loan"
      },
      {
        filter: {
          address: BALANCER_V2_VAULT_ADDRESS,
          topics: [TOPICS.balancerFlashLoan]
        },
        label: "balancer-v2-flash-loan"
      },
      {
        filter: {
          topics: [TOPICS.morphoFlashLoan]
        },
        label: "morpho-flash-loan"
      },
      {
        filter: {
          topics: [TOPICS.uniswapV3Flash]
        },
        label: "uniswap-v3-flash"
      }
    ];
  }

  private async buildUniswapV3PoolSnapshotMap(receipt: RawReceipt): Promise<Map<string, UniswapV3PoolSnapshot>> {
    const poolAddresses = Array.from(new Set(
      receipt.logs
        .filter((log) => log.topics[0]?.toLowerCase() === TOPICS.uniswapV3Flash)
        .map((log) => normalizeAddress(log.address))
        .filter((value): value is string => value !== null)
    ));

    const snapshots = await Promise.all(poolAddresses.map(async (poolAddress) => (
      [poolAddress, await this.fetcher.getUniswapV3PoolSnapshot(poolAddress)] as const
    )));

    return new Map(
      snapshots.filter((entry): entry is readonly [string, UniswapV3PoolSnapshot] => entry[1] !== null)
    );
  }

  private async backfillRangeByBlocks(fromBlock: number, toBlock: number, resume: boolean): Promise<void> {
    const checkpointKey = this.buildBackfillCheckpointKey("blocks", fromBlock, toBlock);
    let nextBlock = fromBlock;
    const existing = this.checkpoints.getBackfillCursor(checkpointKey);

    if (resume && existing) {
      nextBlock = Math.max(fromBlock, existing.nextBlock);
    }

    for (let blockNumber = nextBlock; blockNumber <= toBlock; blockNumber += 1) {
      await this.scanBlock(blockNumber);
      this.checkpoints.setBackfillCursor(checkpointKey, {
        fromBlock,
        mode: "blocks",
        nextBlock: blockNumber + 1,
        toBlock
      });
    }

    this.checkpoints.clearBackfillCursor(checkpointKey);
  }

  private async backfillRangeByLogs(fromBlock: number, toBlock: number, resume: boolean): Promise<void> {
    const checkpointKey = this.buildBackfillCheckpointKey("logs", fromBlock, toBlock);
    let nextBlock = fromBlock;
    const existing = this.checkpoints.getBackfillCursor(checkpointKey);

    if (resume && existing) {
      nextBlock = Math.max(fromBlock, existing.nextBlock);
    }

    while (nextBlock <= toBlock) {
      const endBlock = Math.min(toBlock, nextBlock + this.config.logBackfillBlockSpan - 1);
      const txHashes = await this.findFlashLoanSignalTransactionHashes(nextBlock, endBlock);
      const candidates = await mapWithConcurrency(
        txHashes,
        this.config.maxConcurrentTransactions,
        async (txHash) => this.analyzeTransactionHash(txHash)
      );

      let reportedCount = 0;
      for (const candidate of candidates) {
        if (candidate && this.reporter.reportCandidate(candidate)) {
          reportedCount += 1;
        }
      }

      logInfo(
        `[backfill-logs] from=${nextBlock} to=${endBlock} signalTxs=${txHashes.length} candidates=${reportedCount}`
      );

      this.checkpoints.setBackfillCursor(checkpointKey, {
        fromBlock,
        mode: "logs",
        nextBlock: endBlock + 1,
        toBlock
      });
      nextBlock = endBlock + 1;
    }

    this.checkpoints.clearBackfillCursor(checkpointKey);
  }

  private async skipToLatestFlashLoanSignals(): Promise<void> {
    const latest = await this.fetcher.getLatestBlockNumber();
    const targetBlock = Math.max(0, latest - this.config.finalityConfirmations);
    this.checkpoints.setWsSyncedBlock(targetBlock);
    logInfo(`[ws] skip catchup, listening from future signals after block=${targetBlock}`);
  }

  private startWsCheckpointLoop(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      timer = setTimeout(() => {
        void tick();
      }, this.config.wsCheckpointIntervalMs);
    };

    const tick = async () => {
      if (stopped) return;

      try {
        await this.advanceWsSyncedCheckpoint();
      } catch (error) {
        logWarn(`[ws-checkpoint] error=${String(error instanceof Error ? error.message : error)}`);
      }

      if (!stopped) {
        schedule();
      }
    };

    schedule();

    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }

  private async advanceWsSyncedCheckpoint(): Promise<void> {
    const latest = await this.fetcher.getLatestBlockNumber();
    const syncedBlock = Math.max(0, latest - this.config.finalityConfirmations);
    const current = this.checkpoints.getWsSyncedBlock();

    if (current === null || syncedBlock > current) {
      this.checkpoints.setWsSyncedBlock(syncedBlock);
    }
  }

  private async findFlashLoanSignalTransactionHashes(fromBlock: number, toBlock: number): Promise<string[]> {
    const subscriptions = this.getFlashLoanSignalSubscriptions();

    const logsPerSource: RawReceipt["logs"][] = [];
    for (const subscription of subscriptions) {
      const logs = await this.fetcher.getLogs({
        address: subscription.filter.address,
        fromBlock,
        toBlock,
        topics: subscription.filter.topics
      });
      logsPerSource.push(logs);
    }

    return Array.from(new Set(
      logsPerSource
        .flat()
        .map((log) => log.transactionHash?.toLowerCase())
        .filter((value): value is string => Boolean(value))
    ));
  }

  private buildBackfillCheckpointKey(mode: BackfillMode, fromBlock: number, toBlock: number): string {
    return `${mode}:${fromBlock}:${toBlock}`;
  }

  private async handleFlashLoanSignal(source: string, log: Log): Promise<void> {
    if (log.removed) return;

    const txHash = log.transactionHash.toLowerCase();
    const now = Date.now();
    this.pruneSeenSignalTransactions(now);

    const seenUntil = this.seenSignalTxs.get(txHash);
    if ((seenUntil !== undefined && seenUntil > now) || this.signalTxsInFlight.has(txHash)) {
      return;
    }

    this.seenSignalTxs.set(txHash, now + this.config.wsSignalDedupMs);
    this.signalTxsInFlight.add(txHash);

    try {
      if (this.config.finalityConfirmations > 0) {
        await this.waitForConfirmations(log.blockNumber + this.config.finalityConfirmations);
      }

      const candidate = await this.analyzeTransactionHash(txHash);
      if (!candidate) {
        return;
      }

      this.reporter.reportCandidate(candidate);
      logInfo(
        `[ws-signal] source=${source} block=${candidate.blockNumber} tx=${shortHash(candidate.txHash)} tags=${candidate.tags.join(",")}`
      );
    } catch (error) {
      this.seenSignalTxs.delete(txHash);
      logError(
        `[ws-signal] source=${source} tx=${shortHash(txHash)} error=${String(error instanceof Error ? error.stack ?? error.message : error)}`
      );
    } finally {
      this.signalTxsInFlight.delete(txHash);
    }
  }

  private async waitForConfirmations(targetBlock: number): Promise<void> {
    while (true) {
      const latest = await this.fetcher.getLatestBlockNumber();
      if (latest >= targetBlock) {
        return;
      }

      await sleep(Math.max(500, Math.min(this.config.pollIntervalMs, 2_000)));
    }
  }

  private pruneSeenSignalTransactions(now: number): void {
    for (const [txHash, seenUntil] of this.seenSignalTxs.entries()) {
      if (seenUntil <= now) {
        this.seenSignalTxs.delete(txHash);
      }
    }
  }

  private redactWsUrl(value: string): string {
    const marker = "/v2/";
    const markerIndex = value.indexOf(marker);
    if (markerIndex === -1) {
      return value;
    }

    return `${value.slice(0, markerIndex + marker.length)}***`;
  }
}
