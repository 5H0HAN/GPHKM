export type SupportEventCursor = { createdAt: Date; id: string };

export function encodeSupportEventCursor(cursor: SupportEventCursor) {
  return Buffer.from(`${cursor.createdAt.toISOString()}\n${cursor.id}`).toString("base64url");
}

export function decodeSupportEventCursor(value: string | undefined): SupportEventCursor | null {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_-]{16,256}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.indexOf("\n");
    if (separator < 0) return null;
    const timestamp = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    const createdAt = new Date(timestamp);
    if (createdAt.toISOString() !== timestamp || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch { return null; }
}
