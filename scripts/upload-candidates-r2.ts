import "dotenv/config";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

type ParsedArgs = {
  daily: boolean;
  date: string | null;
  key: string | null;
  keyPrefix: string;
  sourcePath: string;
};

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  let daily = false;
  let date = optional("R2_UPLOAD_DATE");
  let key = optional("R2_OBJECT_KEY");
  let keyPrefix = optional("R2_KEY_PREFIX") ?? "chance-arb/candidates";
  let sourcePath = optional("R2_SOURCE_PATH") ?? optional("OUTPUT_PATH") ?? "./data/candidates.jsonl";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--daily") {
      daily = true;
      continue;
    }

    if (arg === "--date") {
      date = argv[index + 1] ?? date;
      index += 1;
      continue;
    }

    if (arg === "--source") {
      sourcePath = argv[index + 1] ?? sourcePath;
      index += 1;
      continue;
    }

    if (arg === "--key") {
      key = argv[index + 1] ?? key;
      index += 1;
      continue;
    }

    if (arg === "--prefix") {
      keyPrefix = argv[index + 1] ?? keyPrefix;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return {
    daily,
    date,
    key,
    keyPrefix,
    sourcePath: path.resolve(process.cwd(), sourcePath)
  };
}

function printUsage(): void {
  console.log(`Usage: npm run upload:candidates:r2 -- [--daily] [--date YYYY-MM-DD] [--source path] [--prefix key-prefix] [--key object-key]

Required env:
  R2_ACCOUNT_ID
  R2_BUCKET
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY

Optional env:
  R2_KEY_PREFIX=chance-arb/candidates
  R2_OBJECT_KEY=chance-arb/candidates/candidates-YYYY-MM-DD.jsonl
  R2_LATEST_KEY=chance-arb/candidates/latest.jsonl
  R2_SOURCE_PATH=./data/candidates.jsonl
  R2_UPLOAD_DATE=YYYY-MM-DD
  R2_UPLOAD_RETRY_SECONDS=300
`);
}

function datedKey(prefix: string, date: string): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return `${cleanPrefix}/candidates-${date}.jsonl`;
}

function datePath(sourcePath: string, date: string): string {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, `${parsed.name}-${date}${parsed.ext}`);
}

function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function previousUtcDate(reference = new Date()): string {
  const previous = new Date(Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate() - 1
  ));
  return previous.toISOString().slice(0, 10);
}

function millisecondsUntilNextUtcMidnight(reference = new Date()): number {
  const next = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate() + 1
  );
  return Math.max(1_000, next - reference.getTime());
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function snapshotFile(sourcePath: string): string | null {
  if (!fs.existsSync(sourcePath)) {
    console.log(`[r2-upload] source does not exist, skip: ${sourcePath}`);
    return null;
  }

  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size === 0) {
    console.log(`[r2-upload] source is empty or not a file, skip: ${sourcePath}`);
    return null;
  }

  const snapshotPath = path.join(os.tmpdir(), `chance-arb-candidates-${process.pid}-${Date.now()}.jsonl`);
  fs.copyFileSync(sourcePath, snapshotPath);
  return snapshotPath;
}

async function putObject(client: S3Client, bucket: string, key: string, bodyPath: string): Promise<void> {
  const body = fs.createReadStream(bodyPath);
  await client.send(new PutObjectCommand({
    Body: body,
    Bucket: bucket,
    ContentType: "application/x-ndjson",
    Key: key
  }));
}

function createClient(): { bucket: string; client: S3Client; latestKey: string | null } {
  const accountId = required("R2_ACCOUNT_ID");
  const bucket = required("R2_BUCKET");
  const accessKeyId = required("R2_ACCESS_KEY_ID");
  const secretAccessKey = required("R2_SECRET_ACCESS_KEY");
  const latestKey = optional("R2_LATEST_KEY");

  const client = new S3Client({
    credentials: {
      accessKeyId,
      secretAccessKey
    },
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto"
  });

  return { bucket, client, latestKey };
}

async function uploadOnce(args: ParsedArgs): Promise<void> {
  const uploadDate = args.date ?? previousUtcDate();
  if (!isDateString(uploadDate)) {
    throw new Error(`Invalid upload date: ${uploadDate}`);
  }

  const sourcePath = datePath(args.sourcePath, uploadDate);
  const snapshotPath = snapshotFile(sourcePath);
  if (!snapshotPath) return;

  const { bucket, client, latestKey } = createClient();
  const objectKey = args.key ?? datedKey(args.keyPrefix, uploadDate);

  try {
    await putObject(client, bucket, objectKey, snapshotPath);
    console.log(`[r2-upload] uploaded s3://${bucket}/${objectKey}`);

    if (latestKey && latestKey !== objectKey) {
      await putObject(client, bucket, latestKey, snapshotPath);
      console.log(`[r2-upload] uploaded s3://${bucket}/${latestKey}`);
    }
  } finally {
    fs.rmSync(snapshotPath, { force: true });
  }
}

async function runDaily(args: ParsedArgs): Promise<void> {
  for (;;) {
    const waitMs = millisecondsUntilNextUtcMidnight();
    const nextRunAt = new Date(Date.now() + waitMs).toISOString();
    console.log(`[r2-upload] next daily upload at ${nextRunAt}`);
    await sleep(waitMs);

    const uploadDate = previousUtcDate();
    const retryMs = Math.max(30, Number.parseInt(optional("R2_UPLOAD_RETRY_SECONDS") ?? "300", 10)) * 1_000;

    for (;;) {
      try {
        await uploadOnce({ ...args, date: uploadDate, key: optional("R2_OBJECT_KEY") });
        break;
      } catch (error) {
        console.error(`[r2-upload] upload failed for ${uploadDate}: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(retryMs);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.daily) {
    await runDaily(args);
    return;
  }

  await uploadOnce(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
