export async function readBoundedObjectBody(
  body: AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void },
  contentLength: number | undefined,
  maxBytes: number,
) {
  if (!Number.isSafeInteger(contentLength) || contentLength! < 1 || contentLength! > maxBytes) {
    body.destroy?.();
    throw new Error("Private file is unavailable");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      if (!Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 0 || chunk.byteLength > maxBytes - total) {
        body.destroy?.();
        throw new Error("Private file is unavailable");
      }
      total += chunk.byteLength;
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    body.destroy?.();
    throw error;
  }
  if (total !== contentLength) throw new Error("Private file is unavailable");
  return Buffer.concat(chunks, total);
}
