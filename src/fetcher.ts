import { JsonRpcProvider, toQuantity } from "ethers";

import { uniswapV3LikeInterface } from "./constants.js";
import { logWarn } from "./logger.js";
import type { UniswapV3PoolSnapshot } from "./types.js";
import type { RawBlock, RawReceipt, RawTransaction } from "./types.js";
import { mapWithConcurrency, sleep } from "./utils.js";

type BlockBundle = {
  block: RawBlock | null;
  receiptsByHash: Map<string, RawReceipt>;
};

type RawLogFilter = {
  address?: string;
  fromBlock: string;
  toBlock: string;
  topics?: string[];
};

export class ChainFetcher {
  private supportsBlockReceipts: boolean | null = null;
  private readonly uniswapV3PoolCache = new Map<string, Promise<UniswapV3PoolSnapshot | null>>();

  public readonly provider: JsonRpcProvider;

  constructor(rpcUrl: string, private readonly maxConcurrentTransactions: number) {
    this.provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  }

  public async destroy(): Promise<void> {
    await this.provider.destroy();
  }

  public async getLatestBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  public async getTransaction(hash: string): Promise<RawTransaction | null> {
    return this.sendRpc<RawTransaction | null>("eth_getTransactionByHash", [hash]);
  }

  public async getReceipt(hash: string): Promise<RawReceipt | null> {
    return this.sendRpc<RawReceipt | null>("eth_getTransactionReceipt", [hash]);
  }

  public async getBlockTimestamp(blockNumber: number): Promise<number | null> {
    const block = await this.sendRpc<{ timestamp: string } | null>("eth_getBlockByNumber", [
      toQuantity(blockNumber),
      false
    ]);

    return block ? Number.parseInt(block.timestamp, 16) : null;
  }

  public async getBlockBundle(blockNumber: number): Promise<BlockBundle> {
    const block = await this.sendRpc<RawBlock | null>("eth_getBlockByNumber", [
      toQuantity(blockNumber),
      true
    ]);

    if (!block) {
      return {
        block: null,
        receiptsByHash: new Map()
      };
    }

    const receipts = await this.getBlockReceipts(blockNumber, block.transactions);
    return {
      block,
      receiptsByHash: new Map(receipts.map((receipt) => [receipt.transactionHash.toLowerCase(), receipt]))
    };
  }

  public async getLogs(filter: { address?: string; fromBlock: number; toBlock: number; topics?: string[] }): Promise<RawReceipt["logs"]> {
    return this.sendRpc<RawReceipt["logs"]>("eth_getLogs", [{
      address: filter.address,
      fromBlock: toQuantity(filter.fromBlock),
      toBlock: toQuantity(filter.toBlock),
      topics: filter.topics
    } satisfies RawLogFilter]);
  }

  public async getUniswapV3PoolSnapshot(poolAddress: string): Promise<UniswapV3PoolSnapshot | null> {
    const key = poolAddress.toLowerCase();
    const existing = this.uniswapV3PoolCache.get(key);
    if (existing) {
      return existing;
    }

    const task = (async () => {
      try {
        const [token0Raw, token1Raw] = await Promise.all([
          this.provider.call({
            to: key,
            data: uniswapV3LikeInterface.encodeFunctionData("token0")
          }),
          this.provider.call({
            to: key,
            data: uniswapV3LikeInterface.encodeFunctionData("token1")
          })
        ]);

        const token0 = String(uniswapV3LikeInterface.decodeFunctionResult("token0", token0Raw)[0]);
        const token1 = String(uniswapV3LikeInterface.decodeFunctionResult("token1", token1Raw)[0]);
        return {
          token0: token0.toLowerCase(),
          token1: token1.toLowerCase()
        };
      } catch {
        return null;
      }
    })();

    this.uniswapV3PoolCache.set(key, task);
    return task;
  }

  private async getBlockReceipts(
    blockNumber: number,
    transactions: RawTransaction[]
  ): Promise<RawReceipt[]> {
    if (this.supportsBlockReceipts !== false) {
      try {
        const receipts = await this.sendRpc<RawReceipt[]>("eth_getBlockReceipts", [
          toQuantity(blockNumber)
        ]);
        this.supportsBlockReceipts = true;
        return receipts;
      } catch {
        this.supportsBlockReceipts = false;
      }
    }

    const receiptResults = await mapWithConcurrency(
      transactions,
      this.maxConcurrentTransactions,
      async (transaction) => this.getReceipt(transaction.hash)
    );

    return receiptResults.filter((receipt): receipt is RawReceipt => receipt !== null);
  }

  private async sendRpc<T>(method: string, params: unknown[]): Promise<T> {
    const maxAttempts = 6;
    const baseDelayMs = 1_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.provider.send(method, params) as T;
      } catch (error) {
        if (!isRateLimitError(error) || attempt === maxAttempts) {
          throw error;
        }

        const delayMs = baseDelayMs * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        logWarn(`[rpc] rate limited method=${method} attempt=${attempt}/${maxAttempts} retryMs=${delayMs}`);
        await sleep(delayMs);
      }
    }

    throw new Error(`RPC retry exhausted for ${method}`);
  }
}

function isRateLimitError(error: unknown): boolean {
  const candidate = error as {
    code?: string | number;
    error?: { code?: string | number; message?: string };
    info?: { error?: { code?: string | number; message?: string } };
    message?: string;
  };

  const code = candidate.error?.code ?? candidate.info?.error?.code ?? candidate.code;
  const message = [
    candidate.message,
    candidate.error?.message,
    candidate.info?.error?.message
  ].filter(Boolean).join(" ").toLowerCase();

  return code === 429 || message.includes("429") || message.includes("rate limit") || message.includes("compute units");
}
