export function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.toLowerCase();
}

export function hexToBigInt(value: string | null | undefined): bigint | null {
  if (!value) return null;
  return BigInt(value);
}

export function hexToNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  return Number.parseInt(value, 16);
}

export function shortHash(value: string): string {
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, concurrency);
  const results = new Array<R>(values.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
  return results;
}
