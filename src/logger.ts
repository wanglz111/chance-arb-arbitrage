function timestamp(): string {
  return new Date().toISOString();
}

export function logInfo(message: string): void {
  console.log(`${timestamp()} INFO ${message}`);
}

export function logWarn(message: string): void {
  console.warn(`${timestamp()} WARN ${message}`);
}

export function logError(message: string): void {
  console.error(`${timestamp()} ERROR ${message}`);
}
