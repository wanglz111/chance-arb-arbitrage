export type CandidateTag =
  | "flash-loan"
  | "multi-pool-swap"
  | "wrap-unwrap-redeem"
  | "reserve-liquidity-shift"
  | "vault-share-discount-redeem"
  | "liquidation-deleverage-imbalance";

export type FlashLoanProtocol = "aave-v3" | "morpho";

export type LiveMode = "block-poll" | "ws-flashloan";

export type MonitoredSharePair = {
  label: string;
  protocol: string;
  shareToken: string;
  underlyingToken: string;
};

export type AppConfig = {
  chainName: string;
  finalityConfirmations: number;
  liveMode: LiveMode;
  maxConcurrentTransactions: number;
  minCandidateScore: number;
  minFlashLoanWei: bigint;
  minReserveShiftWei: bigint;
  minSwapPools: number;
  monitoredReserveAddresses: string[];
  monitoredSharePairs: MonitoredSharePair[];
  outputPath: string;
  pollIntervalMs: number;
  rpcUrl: string;
  startBlock: number | null;
  wsReconnectDelayMs: number;
  wsRpcUrl: string | null;
  wsSignalDedupMs: number;
};

export type RawTransaction = {
  blockNumber: string | null;
  from: string;
  hash: string;
  input: string;
  nonce: string;
  to: string | null;
  transactionIndex: string | null;
  value: string;
};

export type RawLog = {
  address: string;
  data: string;
  topics: string[];
};

export type RawReceipt = {
  blockNumber: string;
  gasUsed: string;
  logs: RawLog[];
  status: string;
  transactionHash: string;
  transactionIndex: string;
};

export type RawBlock = {
  number: string;
  timestamp: string;
  transactions: RawTransaction[];
};

export type CandidateMetrics = {
  flashLoanAmountWei: string;
  flashLoanCount: number;
  payoutAddressCount: number;
  payoutTokenCount: number;
  reserveShiftDownWei: string;
  reserveShiftUpWei: string;
  swapEvents: number;
  swapPools: number;
  wethDepositWei: string;
  wethWithdrawalWei: string;
};

export type CandidateFlashLoan = {
  amountWei: string;
  asset: string;
  callback: string;
  caller: string | null;
  initiator: string | null;
  premiumWei: string | null;
  protocol: FlashLoanProtocol;
  provider: string;
  receiver: string | null;
};

export type CandidatePayout = {
  netAmountWei: string;
  recipient: string;
  token: string;
};

export type Candidate = {
  blockNumber: number;
  chainName: string;
  evidence: string[];
  flashLoans: CandidateFlashLoan[];
  from: string;
  gasUsedWei: string;
  metrics: CandidateMetrics;
  payouts: CandidatePayout[];
  protocols: string[];
  routeHints: string[];
  score: number;
  summary: string;
  tags: CandidateTag[];
  timestamp: number;
  to: string | null;
  txHash: string;
  txIndex: number | null;
};
