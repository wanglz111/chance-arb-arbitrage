import type { LogDescription } from "ethers";

import {
  AAVE_V3_POOL_ADDRESS,
  aavePoolInterface,
  BALANCER_V2_VAULT_ADDRESS,
  balancerVaultInterface,
  erc20Interface,
  erc4626LikeInterface,
  morphoInterface,
  TOPICS,
  uniswapV2LikeInterface,
  uniswapV3LikeInterface,
  wethInterface
} from "./constants.js";
import type {
  AppConfig,
  Candidate,
  CandidateFlashLoan,
  CandidatePayout,
  CandidateTag,
  FlashLoanProtocol,
  MonitoredSharePair,
  RawLog,
  RawReceipt,
  RawTransaction,
  UniswapV3PoolSnapshot
} from "./types.js";
import { hexToBigInt, hexToNumber, normalizeAddress } from "./utils.js";

type FlashLoanSignal = {
  amount: bigint;
  asset: string;
  callback: string;
  caller: string | null;
  initiator: string | null;
  premium: bigint | null;
  protocol: FlashLoanProtocol;
  provider: string;
  receiver: string | null;
};

type PairSignal = {
  pair: MonitoredSharePair;
  shareTransfers: number;
  underlyingTransfers: number;
};

type TransferSignal = {
  from: string;
  to: string;
  token: string;
  value: bigint;
};

type PayoutSignal = {
  amount: bigint;
  kind: "external-transfer" | "net-inflow";
  recipient: string;
  token: string;
};

type AnalysisState = {
  aaveBorrowCount: number;
  aavePositiveShiftWei: bigint;
  aaveRepayCount: number;
  aaveWithdrawCount: number;
  erc20Transfers: TransferSignal[];
  evidence: string[];
  flashLoans: FlashLoanSignal[];
  liquidationCount: number;
  pairSignals: Map<string, PairSignal>;
  payouts: PayoutSignal[];
  protocols: Set<string>;
  reserveShiftDownWei: bigint;
  reserveShiftUpWei: bigint;
  routeHints: Set<string>;
  swapEventCount: number;
  swapPools: Set<string>;
  vaultDepositCount: number;
  vaultWithdrawCount: number;
  wethDepositWei: bigint;
  wethWithdrawalWei: bigint;
};

type AnalysisInput = {
  config: AppConfig;
  receipt: RawReceipt;
  timestamp: number;
  tx: RawTransaction;
  uniswapV3PoolsByAddress: Map<string, UniswapV3PoolSnapshot>;
};

function decodeLog(interfaceInstance: { parseLog(log: RawLog): LogDescription | null }, log: RawLog): LogDescription | null {
  try {
    return interfaceInstance.parseLog(log);
  } catch {
    return null;
  }
}

function pushEvidence(evidence: string[], line: string): void {
  if (!evidence.includes(line)) {
    evidence.push(line);
  }
}

function getPairSignal(
  state: AnalysisState,
  monitoredPairsByToken: Map<string, MonitoredSharePair>,
  tokenAddress: string
): PairSignal | null {
  const pair = monitoredPairsByToken.get(tokenAddress);
  if (!pair) return null;

  const key = pair.label.toLowerCase();
  const existing = state.pairSignals.get(key);
  if (existing) return existing;

  const created: PairSignal = {
    pair,
    shareTransfers: 0,
    underlyingTransfers: 0
  };
  state.pairSignals.set(key, created);
  return created;
}

function serializeFlashLoan(signal: FlashLoanSignal): CandidateFlashLoan {
  return {
    amountWei: signal.amount.toString(),
    asset: signal.asset,
    callback: signal.callback,
    caller: signal.caller,
    initiator: signal.initiator,
    premiumWei: signal.premium === null ? null : signal.premium.toString(),
    protocol: signal.protocol,
    provider: signal.provider,
    receiver: signal.receiver
  };
}

function serializePayout(signal: PayoutSignal): CandidatePayout {
  return {
    kind: signal.kind,
    netAmountWei: signal.amount.toString(),
    recipient: signal.recipient,
    token: signal.token
  };
}

function buildSummary(tags: CandidateTag[], state: AnalysisState): string {
  const parts = [
    `tags=${tags.join(",")}`,
    `flashLoans=${state.flashLoans.length}`,
    `swapPools=${state.swapPools.size}`,
    `payouts=${state.payouts.length}`,
    `reserveUpWei=${state.reserveShiftUpWei.toString()}`,
    `reserveDownWei=${state.reserveShiftDownWei.toString()}`
  ];

  const flashLoanProviders = Array.from(
    state.flashLoans.reduce((accumulator, signal) => {
      const key = signal.protocol;
      accumulator.set(key, (accumulator.get(key) ?? 0) + 1);
      return accumulator;
    }, new Map<string, number>())
  );

  if (flashLoanProviders.length > 0) {
    parts.push(`flashProviders=${flashLoanProviders.map(([key, count]) => `${key}:${count}`).join("|")}`);
  }

  if (state.routeHints.size > 0) {
    parts.push(`hints=${Array.from(state.routeHints).sort().join("|")}`);
  }

  if (state.wethWithdrawalWei > 0n || state.wethDepositWei > 0n) {
    parts.push(`wethWrapFlow=${state.wethDepositWei.toString()}/${state.wethWithdrawalWei.toString()}`);
  }

  if (state.pairSignals.size > 0) {
    parts.push(`pairs=${Array.from(state.pairSignals.values()).map((pair) => pair.pair.label).join("|")}`);
  }

  return parts.join(" ");
}

function createEmptyState(): AnalysisState {
  return {
    aaveBorrowCount: 0,
    aavePositiveShiftWei: 0n,
    aaveRepayCount: 0,
    aaveWithdrawCount: 0,
    erc20Transfers: [],
    evidence: [],
    flashLoans: [],
    liquidationCount: 0,
    pairSignals: new Map(),
    payouts: [],
    protocols: new Set(),
    reserveShiftDownWei: 0n,
    reserveShiftUpWei: 0n,
    routeHints: new Set(),
    swapEventCount: 0,
    swapPools: new Set(),
    vaultDepositCount: 0,
    vaultWithdrawCount: 0,
    wethDepositWei: 0n,
    wethWithdrawalWei: 0n
  };
}

function trackErc20Transfer(
  state: AnalysisState,
  monitoredPairsByToken: Map<string, MonitoredSharePair>,
  logAddress: string,
  log: RawLog
): void {
  const parsed = decodeLog(erc20Interface, log);
  if (!parsed) return;

  const from = normalizeAddress(String(parsed.args.from));
  const to = normalizeAddress(String(parsed.args.to));
  const value = parsed.args.value as bigint;

  if (from && to) {
    state.erc20Transfers.push({
      from,
      to,
      token: logAddress,
      value
    });
  }

  const pairSignal = getPairSignal(state, monitoredPairsByToken, logAddress);
  if (!pairSignal) return;

  state.protocols.add(pairSignal.pair.protocol);
  if (logAddress === pairSignal.pair.shareToken) {
    pairSignal.shareTransfers += 1;
  }
  if (logAddress === pairSignal.pair.underlyingToken) {
    pairSignal.underlyingTransfers += 1;
  }
}

function trackMorphoFlashLoan(state: AnalysisState, logAddress: string, log: RawLog): void {
  const parsed = decodeLog(morphoInterface, log);
  if (!parsed) return;

  const caller = normalizeAddress(String(parsed.args.caller));
  const asset = normalizeAddress(String(parsed.args.token));
  const amount = parsed.args.assets as bigint;
  if (!asset) return;

  state.protocols.add("morpho");
  state.flashLoans.push({
    amount,
    asset,
    callback: "onMorphoFlashLoan",
    caller,
    initiator: null,
    premium: 0n,
    protocol: "morpho",
    provider: logAddress,
    receiver: caller
  });
  pushEvidence(
    state.evidence,
    `morpho flash loan caller=${caller ?? "unknown"} asset=${asset} amount=${amount.toString()} premium=0`
  );
}

function trackBalancerFlashLoan(state: AnalysisState, logAddress: string, log: RawLog): void {
  if (logAddress !== BALANCER_V2_VAULT_ADDRESS) {
    return;
  }

  const parsed = decodeLog(balancerVaultInterface, log);
  if (!parsed) return;

  const recipient = normalizeAddress(String(parsed.args.recipient));
  const asset = normalizeAddress(String(parsed.args.token));
  const amount = parsed.args.amount as bigint;
  const premium = parsed.args.feeAmount as bigint;
  if (!recipient || !asset) return;

  state.protocols.add("balancer-v2");
  state.flashLoans.push({
    amount,
    asset,
    callback: "receiveFlashLoan",
    caller: null,
    initiator: null,
    premium,
    protocol: "balancer-v2",
    provider: logAddress,
    receiver: recipient
  });
  pushEvidence(
    state.evidence,
    `balancer flash loan recipient=${recipient} asset=${asset} amount=${amount.toString()} premium=${premium.toString()}`
  );
}

function trackUniswapV3Flash(state: AnalysisState, input: AnalysisInput, logAddress: string, log: RawLog): void {
  const parsed = decodeLog(uniswapV3LikeInterface, log);
  if (!parsed || parsed.name !== "Flash") return;

  const poolSnapshot = input.uniswapV3PoolsByAddress.get(logAddress);
  if (!poolSnapshot) return;

  const caller = normalizeAddress(String(parsed.args.sender));
  const recipient = normalizeAddress(String(parsed.args.recipient));
  const amount0 = parsed.args.amount0 as bigint;
  const amount1 = parsed.args.amount1 as bigint;
  const paid0 = parsed.args.paid0 as bigint;
  const paid1 = parsed.args.paid1 as bigint;

  state.protocols.add("uniswap-v3");

  const flashLegs = [
    {
      amount: amount0,
      asset: poolSnapshot.token0,
      premium: paid0 >= amount0 ? paid0 - amount0 : 0n
    },
    {
      amount: amount1,
      asset: poolSnapshot.token1,
      premium: paid1 >= amount1 ? paid1 - amount1 : 0n
    }
  ];

  for (const leg of flashLegs) {
    if (leg.amount <= 0n) continue;
    state.flashLoans.push({
      amount: leg.amount,
      asset: leg.asset,
      callback: "uniswapV3FlashCallback",
      caller,
      initiator: null,
      premium: leg.premium,
      protocol: "uniswap-v3",
      provider: logAddress,
      receiver: recipient
    });
    pushEvidence(
      state.evidence,
      `uniswap v3 flash pool=${logAddress} caller=${caller ?? "unknown"} recipient=${recipient ?? "unknown"} asset=${leg.asset} amount=${leg.amount.toString()} premium=${leg.premium.toString()}`
    );
  }
}

function trackAaveLog(
  state: AnalysisState,
  monitoredReserves: Set<string>,
  logAddress: string,
  log: RawLog
): void {
  if (logAddress !== AAVE_V3_POOL_ADDRESS) {
    return;
  }

  const parsed = decodeLog(aavePoolInterface, log);
  if (!parsed) return;

  state.protocols.add("aave-v3");

  if (parsed.name === "Supply") {
    const reserve = normalizeAddress(String(parsed.args.reserve));
    const amount = parsed.args.amount as bigint;
    if (reserve && monitoredReserves.has(reserve)) {
      state.reserveShiftUpWei += amount;
      state.aavePositiveShiftWei += amount;
      pushEvidence(state.evidence, `aave supply reserve=${reserve} amount=${amount.toString()}`);
    }
    return;
  }

  if (parsed.name === "Repay") {
    const reserve = normalizeAddress(String(parsed.args.reserve));
    const amount = parsed.args.amount as bigint;
    state.aaveRepayCount += 1;
    if (reserve && monitoredReserves.has(reserve)) {
      state.reserveShiftUpWei += amount;
      state.aavePositiveShiftWei += amount;
      pushEvidence(state.evidence, `aave repay reserve=${reserve} amount=${amount.toString()}`);
    }
    return;
  }

  if (parsed.name === "Withdraw") {
    const reserve = normalizeAddress(String(parsed.args.reserve));
    const amount = parsed.args.amount as bigint;
    state.aaveWithdrawCount += 1;
    if (reserve && monitoredReserves.has(reserve)) {
      state.reserveShiftDownWei += amount;
      pushEvidence(state.evidence, `aave withdraw reserve=${reserve} amount=${amount.toString()}`);
    }
    return;
  }

  if (parsed.name === "Borrow") {
    const reserve = normalizeAddress(String(parsed.args.reserve));
    const amount = parsed.args.amount as bigint;
    state.aaveBorrowCount += 1;
    if (reserve && monitoredReserves.has(reserve)) {
      state.reserveShiftDownWei += amount;
      pushEvidence(state.evidence, `aave borrow reserve=${reserve} amount=${amount.toString()}`);
    }
    return;
  }

  if (parsed.name === "LiquidationCall") {
    state.liquidationCount += 1;
    pushEvidence(
      state.evidence,
      `liquidation debtToCover=${String(parsed.args.debtToCover)} collateralOut=${String(parsed.args.liquidatedCollateralAmount)}`
    );
    return;
  }

  if (parsed.name === "FlashLoan") {
    const asset = normalizeAddress(String(parsed.args.asset));
    const receiver = normalizeAddress(String(parsed.args.target));
    const initiator = normalizeAddress(String(parsed.args.initiator));
    const amount = parsed.args.amount as bigint;
    const premium = parsed.args.premium as bigint;
    if (!asset) return;

    state.flashLoans.push({
      amount,
      asset,
      callback: "executeOperation",
      caller: initiator,
      initiator,
      premium,
      protocol: "aave-v3",
      provider: logAddress,
      receiver
    });
    pushEvidence(
      state.evidence,
      `aave flash loan receiver=${receiver ?? "unknown"} initiator=${initiator ?? "unknown"} asset=${asset} amount=${amount.toString()} premium=${premium.toString()}`
    );
  }
}

function analyzeLog(
  input: AnalysisInput,
  state: AnalysisState,
  monitoredPairsByToken: Map<string, MonitoredSharePair>,
  monitoredReserves: Set<string>,
  log: RawLog
): void {
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0) return;

  const logAddress = normalizeAddress(log.address);
  if (!logAddress) return;

  if (topic0 === TOPICS.uniswapV2Swap) {
    state.protocols.add("uniswap-v2-like");
    state.swapEventCount += 1;
    state.swapPools.add(logAddress);
    return;
  }

  if (topic0 === TOPICS.uniswapV3Swap) {
    state.protocols.add("uniswap-v3-like");
    state.swapEventCount += 1;
    state.swapPools.add(logAddress);
    return;
  }

  if (topic0 === TOPICS.uniswapV3Flash) {
    trackUniswapV3Flash(state, input, logAddress, log);
    return;
  }

  if (topic0 === TOPICS.wethDeposit) {
    const parsed = decodeLog(wethInterface, log);
    if (!parsed) return;
    state.protocols.add("weth");
    state.wethDepositWei += parsed.args.wad as bigint;
    return;
  }

  if (topic0 === TOPICS.wethWithdrawal) {
    const parsed = decodeLog(wethInterface, log);
    if (!parsed) return;
    state.protocols.add("weth");
    state.wethWithdrawalWei += parsed.args.wad as bigint;
    return;
  }

  if (topic0 === TOPICS.erc4626Deposit) {
    const parsed = decodeLog(erc4626LikeInterface, log);
    if (!parsed) return;
    state.protocols.add("erc4626-like");
    state.vaultDepositCount += 1;
    pushEvidence(
      state.evidence,
      `vault deposit assets=${String(parsed.args.assets)} shares=${String(parsed.args.shares)} vault=${logAddress}`
    );
    return;
  }

  if (topic0 === TOPICS.erc4626Withdraw) {
    const parsed = decodeLog(erc4626LikeInterface, log);
    if (!parsed) return;
    state.protocols.add("erc4626-like");
    state.vaultWithdrawCount += 1;
    pushEvidence(
      state.evidence,
      `vault withdraw assets=${String(parsed.args.assets)} shares=${String(parsed.args.shares)} vault=${logAddress}`
    );
    return;
  }

  if (topic0 === TOPICS.erc20Transfer) {
    trackErc20Transfer(state, monitoredPairsByToken, logAddress, log);
    return;
  }

  if (topic0 === TOPICS.morphoFlashLoan) {
    trackMorphoFlashLoan(state, logAddress, log);
    return;
  }

  if (topic0 === TOPICS.balancerFlashLoan) {
    trackBalancerFlashLoan(state, logAddress, log);
    return;
  }

  trackAaveLog(state, monitoredReserves, logAddress, log);
}

function finalizePayouts(input: AnalysisInput, state: AnalysisState): void {
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const watchedAddresses = new Set<string>();
  const providerAddresses = new Set(state.flashLoans.map((signal) => signal.provider));
  const logEmitterAddresses = new Set(
    input.receipt.logs
      .map((log) => normalizeAddress(log.address))
      .filter((value): value is string => value !== null)
  );

  const txCaller = normalizeAddress(input.tx.from);
  if (txCaller) watchedAddresses.add(txCaller);

  const txTarget = normalizeAddress(input.tx.to);
  if (txTarget) watchedAddresses.add(txTarget);

  for (const signal of state.flashLoans) {
    if (signal.caller) watchedAddresses.add(signal.caller);
    if (signal.initiator) watchedAddresses.add(signal.initiator);
    if (signal.receiver) watchedAddresses.add(signal.receiver);
  }

  for (const providerAddress of providerAddresses) {
    watchedAddresses.delete(providerAddress);
  }

  const netInflowByRecipientAndToken = new Map<string, bigint>();
  const externalTransferByRecipientAndToken = new Map<string, bigint>();
  for (const transfer of state.erc20Transfers) {
    if (watchedAddresses.has(transfer.to)) {
      const key = `${transfer.to}:${transfer.token}`;
      netInflowByRecipientAndToken.set(key, (netInflowByRecipientAndToken.get(key) ?? 0n) + transfer.value);
    }

    if (watchedAddresses.has(transfer.from)) {
      const key = `${transfer.from}:${transfer.token}`;
      netInflowByRecipientAndToken.set(key, (netInflowByRecipientAndToken.get(key) ?? 0n) - transfer.value);
    }

    const isExternalRecipient = (
      transfer.to !== zeroAddress
      && !watchedAddresses.has(transfer.to)
      && !providerAddresses.has(transfer.to)
      && !logEmitterAddresses.has(transfer.to)
    );
    if (watchedAddresses.has(transfer.from) && isExternalRecipient) {
      const key = `${transfer.to}:${transfer.token}`;
      externalTransferByRecipientAndToken.set(key, (externalTransferByRecipientAndToken.get(key) ?? 0n) + transfer.value);
    }
  }

  state.payouts = [
    ...Array.from(netInflowByRecipientAndToken.entries())
      .filter(([, amount]) => amount > 0n)
      .map(([key, amount]) => ({ key, amount, kind: "net-inflow" as const })),
    ...Array.from(externalTransferByRecipientAndToken.entries())
      .filter(([, amount]) => amount > 0n)
      .map(([key, amount]) => ({ key, amount, kind: "external-transfer" as const }))
  ]
    .map(({ key, amount, kind }) => {
      const separatorIndex = key.indexOf(":");
      return {
        amount,
        kind,
        recipient: key.slice(0, separatorIndex),
        token: key.slice(separatorIndex + 1)
      };
    })
    .sort((left, right) => {
      if (left.amount === right.amount) {
        return left.recipient.localeCompare(right.recipient);
      }
      return left.amount > right.amount ? -1 : 1;
    });

  for (const payout of state.payouts) {
    pushEvidence(
      state.evidence,
      `payout recipient=${payout.recipient} token=${payout.token} net=${payout.amount.toString()} kind=${payout.kind}`
    );
  }
}

function finalizeRouteHints(state: AnalysisState): void {
  if (state.flashLoans.length === 0) {
    return;
  }

  state.routeHints.add("flash-loan-open");

  for (const flashLoan of state.flashLoans) {
    state.routeHints.add(`${flashLoan.protocol} -> ${flashLoan.callback}`);
    if (flashLoan.protocol === "morpho") {
      state.routeHints.add("morpho-free-flash-loan");
    }
  }

  if (state.swapPools.size > 0) {
    state.routeHints.add("flash-loan -> swap");
  }

  if (state.swapPools.size >= 2) {
    state.routeHints.add("flash-loan -> multi-pool-swap");
  }

  if (state.aaveRepayCount > 0 || state.aaveWithdrawCount > 0 || state.vaultWithdrawCount > 0) {
    state.routeHints.add("flash-loan -> repay/withdraw");
  }

  if (state.payouts.length > 0) {
    state.routeHints.add("flash-loan -> payout");
  }
}

function deriveTags(config: AppConfig, state: AnalysisState): { score: number; tags: CandidateTag[] } {
  const tags: CandidateTag[] = [];
  let score = 0;

  const flashLoanAmount = state.flashLoans.reduce((sum, item) => sum + item.amount, 0n);
  const hasFlashLoanPathSignal = (
    state.payouts.length > 0
    || state.swapPools.size > 0
    || state.aaveRepayCount > 0
    || state.aaveWithdrawCount > 0
    || state.vaultWithdrawCount > 0
  );
  if (state.flashLoans.length > 0 && (flashLoanAmount >= config.minFlashLoanWei || hasFlashLoanPathSignal)) {
    tags.push("flash-loan");
    score += 3;
  }

  if (state.payouts.length > 0) {
    tags.push("payout");
    score += 1;
  }

  if (state.swapPools.size >= config.minSwapPools) {
    tags.push("multi-pool-swap");
    score += 2;
  }

  if (state.wethWithdrawalWei > 0n && (state.aaveWithdrawCount > 0 || state.vaultWithdrawCount > 0 || state.pairSignals.size > 0)) {
    tags.push("wrap-unwrap-redeem");
    score += 2;
  }

  if (state.aavePositiveShiftWei >= config.minReserveShiftWei) {
    tags.push("reserve-liquidity-shift");
    score += 3;
  }

  const pairTouchCount = Array.from(state.pairSignals.values()).filter((pairSignal) => (
    pairSignal.shareTransfers > 0 && pairSignal.underlyingTransfers > 0
  )).length;
  if (pairTouchCount > 0 && (state.swapEventCount > 0 || state.wethWithdrawalWei > 0n || state.vaultWithdrawCount > 0)) {
    tags.push("vault-share-discount-redeem");
    score += 3;
  }

  if (
    state.liquidationCount > 0
    || (state.flashLoans.length > 0 && state.aaveRepayCount > 0 && state.aaveWithdrawCount > 0)
    || (state.aaveRepayCount > 0 && state.aaveWithdrawCount > 0 && state.swapPools.size > 0)
  ) {
    tags.push("liquidation-deleverage-imbalance");
    score += 3;
  }

  if (tags.length >= 3) {
    score += 1;
  }

  return { score, tags };
}

export function classifyTransaction(input: AnalysisInput): Candidate | null {
  const txHash = input.tx.hash.toLowerCase();
  const from = normalizeAddress(input.tx.from);
  if (!from) return null;

  const txIndex = hexToNumber(input.tx.transactionIndex);
  const blockNumber = hexToNumber(input.receipt.blockNumber);
  const gasUsed = hexToBigInt(input.receipt.gasUsed);
  if (blockNumber === null || gasUsed === null) return null;

  const state = createEmptyState();
  const monitoredReserves = new Set(input.config.monitoredReserveAddresses.map((value) => value.toLowerCase()));
  const monitoredPairsByToken = new Map<string, MonitoredSharePair>();
  for (const pair of input.config.monitoredSharePairs) {
    monitoredPairsByToken.set(pair.shareToken, pair);
    monitoredPairsByToken.set(pair.underlyingToken, pair);
  }

  for (const log of input.receipt.logs) {
    analyzeLog(input, state, monitoredPairsByToken, monitoredReserves, log);
  }

  finalizePayouts(input, state);
  finalizeRouteHints(state);

  const { score, tags } = deriveTags(input.config, state);
  if (tags.length === 0 || score < input.config.minCandidateScore) {
    return null;
  }

  return {
    blockNumber,
    chainName: input.config.chainName,
    evidence: state.evidence,
    flashLoans: state.flashLoans.map(serializeFlashLoan),
    from,
    gasUsedWei: gasUsed.toString(),
    metrics: {
      flashLoanAmountWei: state.flashLoans.reduce((sum, item) => sum + item.amount, 0n).toString(),
      flashLoanCount: state.flashLoans.length,
      payoutAddressCount: new Set(state.payouts.map((item) => item.recipient)).size,
      payoutTokenCount: new Set(state.payouts.map((item) => item.token)).size,
      reserveShiftDownWei: state.reserveShiftDownWei.toString(),
      reserveShiftUpWei: state.reserveShiftUpWei.toString(),
      swapEvents: state.swapEventCount,
      swapPools: state.swapPools.size,
      wethDepositWei: state.wethDepositWei.toString(),
      wethWithdrawalWei: state.wethWithdrawalWei.toString()
    },
    payouts: state.payouts.map(serializePayout),
    protocols: Array.from(state.protocols).sort(),
    routeHints: Array.from(state.routeHints).sort(),
    score,
    summary: buildSummary(tags, state),
    tags,
    timestamp: input.timestamp,
    to: normalizeAddress(input.tx.to),
    txHash,
    txIndex
  };
}
