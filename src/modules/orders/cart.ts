export type CustomerCartDraft = {
  targetUrl: string;
  anchorText: string;
  instructions: string;
  articleText: string;
  writingBrief: string;
  useWriting: boolean;
};

export type CustomerCartVersion = { version: number; generationId: string };

const fields = {
  targetUrl: 2048,
  anchorText: 200,
  instructions: 4000,
  articleText: 20000,
  writingBrief: 4000,
} as const;

export function validateCustomerCartDraft(value: unknown): CustomerCartDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cart details");
  const input = value as Record<string, unknown>;
  const allowedFields = [...Object.keys(fields), "useWriting"];
  if (Object.keys(input).some((key) => !allowedFields.includes(key))) throw new Error("Invalid cart details");

  const draft = Object.fromEntries(Object.entries(fields).map(([field, maxLength]) => {
    const text = input[field] ?? "";
    if (typeof text !== "string" || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error("Invalid cart details");
    }
    return [field, text];
  })) as Omit<CustomerCartDraft, "useWriting">;
  if (input.useWriting !== undefined && typeof input.useWriting !== "boolean") throw new Error("Invalid cart details");
  const targetUrl = draft.targetUrl.trim();
  if (targetUrl) {
    if (/\s/.test(targetUrl)) throw new Error("Invalid cart details");
    try {
      const url = new URL(targetUrl);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error();
    } catch {
      throw new Error("Invalid cart details");
    }
  }
  draft.targetUrl = targetUrl;
  if (draft.anchorText.includes("\n") || draft.anchorText.includes("\r") || draft.anchorText.includes("\t")) throw new Error("Invalid cart details");
  return { ...draft, useWriting: input.useWriting === true };
}
