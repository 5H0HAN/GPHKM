export function parseUsdMinor(value: string, allowZero = false): string | null {
  const match = /^(0|[1-9]\d{0,17})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return (allowZero || cents > 0n) ? cents.toString() : null;
}

export function normalizeFinanceReason(value: string): string | null {
  const reason = value.trim();
  return reason.length >= 3 && reason.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(reason) ? reason : null;
}

export function normalizeEvidenceReference(value: string): string | null {
  const reference = value.trim();
  return reference.length >= 1 && reference.length <= 500 && !/[\u0000-\u001f\u007f]/.test(reference) && !/^https?:\/\//i.test(reference) ? reference : null;
}

export function normalizeTransferReference(value: string): string | null {
  const reference = value.trim();
  return reference.length >= 1 && reference.length <= 200 && !/[\u0000-\u001f\u007f]/.test(reference) && !/^https?:\/\//i.test(reference) ? reference : null;
}

export function validSupplierTransferEvidence(kind: unknown, bytes: Uint8Array): kind is "PDF" | "EML" {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 5 * 1024 * 1024) return false;
  if (kind === "PDF") return bytes.byteLength >= 5 && Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"));
  if (kind !== "EML" || bytes.includes(0)) return false;
  const input = Buffer.from(bytes);
  const crlfSeparator = Buffer.from("\r\n\r\n");
  const lfSeparator = Buffer.from("\n\n");
  const crlfIndex = input.indexOf(crlfSeparator);
  const lfIndex = input.indexOf(lfSeparator);
  const separatorIndex = crlfIndex < 0 ? lfIndex : lfIndex < 0 ? crlfIndex : Math.min(crlfIndex, lfIndex);
  if (separatorIndex < 0 || separatorIndex > 64 * 1024) return false;
  const header = input.subarray(0, separatorIndex).toString("latin1");
  const lines = header.split(/\r?\n/);
  let hasField = false;
  for (const line of lines) {
    if (/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) return false;
    if (/^[\t ]/.test(line)) {
      if (!hasField) return false;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1 || !/^[\x21-\x39\x3b-\x7e]+$/.test(line.slice(0, colon))) return false;
    hasField = true;
  }
  return hasField;
}

export function parsePaymentDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}
