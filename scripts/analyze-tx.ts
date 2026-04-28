import { inspect } from "node:util";

import { loadConfig } from "../src/config.js";
import { CandidateDiscoveryService } from "../src/service.js";

function requireHash(argv: string[]): string {
  const value = argv[0]?.trim();
  if (!value) {
    throw new Error("Usage: npm run analyze:tx -- <tx-hash>");
  }
  return value;
}

async function main(): Promise<void> {
  const hash = requireHash(process.argv.slice(2));
  const config = loadConfig();
  const service = new CandidateDiscoveryService(config);

  try {
    const candidate = await service.analyzeTransactionHash(hash);
    if (!candidate) {
      console.log("No candidate tags matched.");
      return;
    }

    console.log(inspect(candidate, {
      colors: true,
      depth: null,
      compact: false
    }));
  } finally {
    await service.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
