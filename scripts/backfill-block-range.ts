import { loadConfig } from "../src/config.js";
import { CandidateDiscoveryService } from "../src/service.js";

type Args = {
  from: number;
  to: number;
};

function parseInteger(value: string | undefined, name: string): number {
  if (!value) {
    throw new Error(`Missing value for ${name}`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  let from: number | null = null;
  let to: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from") {
      from = parseInteger(argv[index + 1], "--from");
      index += 1;
      continue;
    }
    if (arg === "--to") {
      to = parseInteger(argv[index + 1], "--to");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (from === null || to === null) {
    throw new Error("Usage: npm run backfill -- --from <block> --to <block>");
  }
  if (to < from) {
    throw new Error("--to must be greater than or equal to --from");
  }

  return { from, to };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const service = new CandidateDiscoveryService(config);

  try {
    await service.scanRange(args.from, args.to);
  } finally {
    await service.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
