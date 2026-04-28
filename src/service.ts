import type { Log, WebSocketLike } from "ethers";
import { WebSocketProvider } from "ethers";

import { classifyTransaction } from "./classifier.js";
import { AAVE_V3_POOL_ADDRESS, TOPICS } from "./constants.js";
import { ChainFetcher } from "./fetcher.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { CandidateReporter } from "./reporter.js";
import type { AppConfig, Candidate } from "./types.js";
import { mapWithConcurrency, shortHash, sleep } from "./utils.js";

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
  private readonly fetcher: ChainFetcher;
  private readonly reporter: CandidateReporter;
  private readonly seenSignalTxs = new Map<string, number>();
  private readonly signalTxsInFlight = new Set<string>();

  private wsProvider: WebSocketProvider | null = null;

  constructor(private readonly config: AppConfig) {
    this.fetcher = new ChainFetcher(config.rpcUrl, config.maxConcurrentTransactions);
    this.reporter = new CandidateReporter(config.outputPath);
  }

  public async destroy(): Promise<void> {
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

    return classifyTransaction({
      config: this.config,
      receipt,
      timestamp,
      tx
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

        return classifyTransaction({
          config: this.config,
          receipt,
          timestamp,
          tx
        });
      }
    );

    const filtered = candidates.filter((candidate): candidate is Candidate => candidate !== null);
    for (const candidate of filtered) {
      this.reporter.reportCandidate(candidate);
    }
    this.reporter.reportBlockSummary(blockNumber, bundle.block.transactions.length, filtered.length);
    return filtered;
  }

  public async scanRange(fromBlock: number, toBlock: number): Promise<void> {
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      await this.scanBlock(blockNumber);
    }
  }

  public async runLive(): Promise<void> {
    let nextBlock = this.config.startBlock;
    if (nextBlock === null) {
      const latest = await this.fetcher.getLatestBlockNumber();
      nextBlock = Math.max(0, latest - this.config.finalityConfirmations);
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
      `[live] mode=ws-flashloan chain=${this.config.chainName} confirmations=${this.config.finalityConfirmations} reconnectMs=${this.config.wsReconnectDelayMs} dedupMs=${this.config.wsSignalDedupMs} signals=${subscriptions.map((item) => item.label).join(",")}`
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
          topics: [TOPICS.morphoFlashLoan]
        },
        label: "morpho-flash-loan"
      }
    ];
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
