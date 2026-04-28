import "dotenv/config";

import path from "node:path";

import {
  AARBWETH_ADDRESS,
  ARBITRUM_CHAIN_NAME,
  WETH_ADDRESS
} from "./constants.js";
import type { AppConfig, LiveMode, MonitoredSharePair } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function parseInteger(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return parsed;
}

function parseLiveMode(name: string, fallback: LiveMode): LiveMode {
  const raw = optional(name);
  if (!raw) return fallback;

  if (raw === "block-poll" || raw === "ws-flashloan") {
    return raw;
  }

  throw new Error(`Invalid ${name}: ${raw}`);
}

function parseBigIntValue(name: string, fallback: bigint): bigint {
  const raw = optional(name);
  if (!raw) return fallback;
  return BigInt(raw);
}

function parseAddressList(value: string | null, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseSharePairs(value: string | null): MonitoredSharePair[] {
  const raw = value ?? `Aave-aArbWETH:${AARBWETH_ADDRESS}:${WETH_ADDRESS}:aave-v3`;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, shareToken, underlyingToken, protocol] = entry.split(":");
      if (!label || !shareToken || !underlyingToken) {
        throw new Error(`Invalid MONITORED_SHARE_PAIRS entry: ${entry}`);
      }
      return {
        label,
        protocol: protocol ?? "unknown",
        shareToken: shareToken.toLowerCase(),
        underlyingToken: underlyingToken.toLowerCase()
      };
    });
}

export function loadConfig(): AppConfig {
  const rpcUrl = required("RPC_URL");
  const liveMode = parseLiveMode("LIVE_MODE", "block-poll");
  const wsRpcUrl = optional("WS_RPC_URL");

  if (liveMode === "ws-flashloan" && !wsRpcUrl) {
    throw new Error("Missing required env var for ws-flashloan mode: WS_RPC_URL");
  }

  return {
    chainName: ARBITRUM_CHAIN_NAME,
    finalityConfirmations: parseInteger("FINALITY_CONFIRMATIONS", 0),
    liveMode,
    maxConcurrentTransactions: parseInteger("MAX_CONCURRENT_TRANSACTIONS", 12),
    minCandidateScore: parseInteger("MIN_CANDIDATE_SCORE", 2),
    minFlashLoanWei: parseBigIntValue("MIN_FLASH_LOAN_WEI", 1_000_000_000_000_000_000n),
    minReserveShiftWei: parseBigIntValue("MIN_RESERVE_SHIFT_WEI", 1_000_000_000_000_000_000n),
    minSwapPools: parseInteger("MIN_SWAP_POOLS", 2),
    monitoredReserveAddresses: parseAddressList(optional("MONITORED_RESERVES"), [WETH_ADDRESS]),
    monitoredSharePairs: parseSharePairs(optional("MONITORED_SHARE_PAIRS")),
    outputPath: path.resolve(process.cwd(), optional("OUTPUT_PATH") ?? "./data/candidates.jsonl"),
    pollIntervalMs: parseInteger("POLL_INTERVAL_MS", 1_500),
    rpcUrl,
    startBlock: optional("START_BLOCK") ? parseInteger("START_BLOCK", 0) : null,
    wsReconnectDelayMs: parseInteger("WS_RECONNECT_DELAY_MS", 5_000),
    wsRpcUrl,
    wsSignalDedupMs: parseInteger("WS_SIGNAL_DEDUP_MS", 30_000)
  };
}
