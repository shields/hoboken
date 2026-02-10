function stamp(): string {
  return new Date().toISOString();
}

export function log(message: string): void {
  console.log(`${stamp()} ${message}`);
}

export function warn(message: string): void {
  console.warn(`${stamp()} ${message}`);
}

export function error(message: string): void {
  console.error(`${stamp()} ${message}`);
}
