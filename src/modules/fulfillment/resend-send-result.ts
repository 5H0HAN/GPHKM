import { readSmallJsonResponse } from "../security/small-json-response.ts";

export function isDefinitiveResendRejection(status: number): boolean {
  // A conflicting idempotency key may belong to a previously accepted send.
  return status >= 400 && status < 500 && status !== 409;
}

export async function readResendMessageId(response: Response): Promise<string | null> {
  try {
    const { id } = await readSmallJsonResponse<{ id?: unknown }>(response);
    return typeof id === "string" && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
