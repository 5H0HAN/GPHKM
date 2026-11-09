export type SupportEventCursor = { createdAt: string; id: string };

export function encodeSupportEventCursor(cursor: SupportEventCursor) {
  return Buffer.from(`${cursor.createdAt}\n${cursor.id}`).toString("base64url");
}

export function decodeSupportEventCursor(value: string | undefined): SupportEventCursor | null {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_-]{16,256}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.indexOf("\n");
    if (separator < 0) return null;
    const timestamp = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(timestamp) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const milliseconds = timestamp.slice(0, 23) + "Z";
    if (new Date(milliseconds).toISOString() !== milliseconds) return null;
    return { createdAt: timestamp, id };
  } catch { return null; }
}
