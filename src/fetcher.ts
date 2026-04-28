import { JsonRpcProvider, toQuantity } from "ethers";

import type { RawBlock, RawReceipt, RawTransaction } from "./types.js";
import { mapWithConcurrency } from "./utils.js";

type BlockBundle = {
  block: RawBlock | null;
  receiptsByHash: Map<string, RawReceipt>;
};

export class ChainFetcher {
  private supportsBlockReceipts: boolean | null = null;

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
