const MAX_RESPONSE_BYTES = 256 * 1024;

export async function readSmallJsonResponse<T>(response: Response): Promise<T> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const lengthHeader = response.headers.get("content-length");
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
  if (mediaType !== "application/json" ||
      (lengthHeader !== null && (!Number.isSafeInteger(declaredLength) || declaredLength! < 0 || declaredLength! > MAX_RESPONSE_BYTES)) ||
      !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Provider JSON response is invalid or too large");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Provider JSON response is invalid or too large");
      chunks.push(value);
    }
    const content = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(content) as T;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("Provider JSON response is invalid or too large");
  } finally {
    reader.releaseLock();
  }
}
