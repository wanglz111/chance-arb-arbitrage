import { loadConfig } from "./config.js";
import { logError } from "./logger.js";
import { CandidateDiscoveryService } from "./service.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const service = new CandidateDiscoveryService(config);

  try {
    await service.run();
  } finally {
    await service.destroy();
  }
}

main().catch((error) => {
  logError(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
});
