export function z2mBrightnessToHomeKit(z2m: number): number {
  if (Number.isNaN(z2m)) throw new RangeError("brightness must be a number");
  return Math.round((Math.max(0, Math.min(254, z2m)) / 254) * 100);
}

export function homeKitBrightnessToZ2M(hk: number): number {
  if (Number.isNaN(hk)) throw new RangeError("brightness must be a number");
  return Math.round((Math.max(0, Math.min(100, hk)) / 100) * 254);
}
