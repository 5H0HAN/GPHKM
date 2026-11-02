export type MetricUrlSnapshot = { websiteUrl: string; version: string };

export function compareMetricTimestampVersions(left: string, right: string): -1 | 0 | 1 {
  const toMicros = (value: string): bigint => {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) throw new Error("Invalid database timestamp version");
    const sign = match[1] === "-" ? -1n : 1n;
    const seconds = BigInt(match[2]!);
    const fractionalMicros = BigInt((match[3] ?? "").padEnd(6, "0").slice(0, 6));
    return sign * (seconds * 1_000_000n + fractionalMicros);
  };
  const leftMicros = toMicros(left);
  const rightMicros = toMicros(right);
  return leftMicros < rightMicros ? -1 : leftMicros > rightMicros ? 1 : 0;
}

export function isSameMetricUrlSnapshot(captured: MetricUrlSnapshot, current: MetricUrlSnapshot): boolean {
  return captured.websiteUrl === current.websiteUrl && captured.version === current.version;
}
