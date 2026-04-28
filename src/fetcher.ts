import { JsonRpcProvider, toQuantity } from "ethers";

import { uniswapV3LikeInterface } from "./constants.js";
import type { UniswapV3PoolSnapshot } from "./types.js";
import type { RawBlock, RawReceipt, RawTransaction } from "./types.js";
import { mapWithConcurrency } from "./utils.js";

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
    return this.provider.send("eth_getTransactionByHash", [hash]) as Promise<RawTransaction | null>;
  }

  public async getReceipt(hash: string): Promise<RawReceipt | null> {
    return this.provider.send("eth_getTransactionReceipt", [hash]) as Promise<RawReceipt | null>;
  }

  public async getBlockTimestamp(blockNumber: number): Promise<number | null> {
    const block = await this.provider.send("eth_getBlockByNumber", [
      toQuantity(blockNumber),
      false
    ]) as { timestamp: string } | null;

    return block ? Number.parseInt(block.timestamp, 16) : null;
  }

  public async getBlockBundle(blockNumber: number): Promise<BlockBundle> {
    const block = await this.provider.send("eth_getBlockByNumber", [
      toQuantity(blockNumber),
      true
    ]) as RawBlock | null;

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
    return this.provider.send("eth_getLogs", [{
      address: filter.address,
      fromBlock: toQuantity(filter.fromBlock),
      toBlock: toQuantity(filter.toBlock),
      topics: filter.topics
    } satisfies RawLogFilter]) as Promise<RawReceipt["logs"]>;
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
        const receipts = await this.provider.send("eth_getBlockReceipts", [
          toQuantity(blockNumber)
        ]) as RawReceipt[];
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
}
