export type WritingState = "WAITING_FOR_FIRST_DRAFT" | "FIRST_DRAFT_READY" | "REVISION_REQUESTED" | "FINAL_DRAFT_READY" | "APPROVED_FIRST" | "APPROVED_FINAL" | "CUSTOMER_DECLINED_FINAL";
export type WritingCommand = "FIRST_DRAFT" | "FINAL_DRAFT" | "REQUEST_REVISION" | "APPROVE" | "DECLINE_FINAL";

export function validateWritingText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error("Writing text is invalid");
  }
  return value.trim();
}

export function nextWritingState(state: string, command: WritingCommand): WritingState {
  const transitions: Record<string, Partial<Record<WritingCommand, WritingState>>> = {
    WAITING_FOR_FIRST_DRAFT: { FIRST_DRAFT: "FIRST_DRAFT_READY" },
    FIRST_DRAFT_READY: { REQUEST_REVISION: "REVISION_REQUESTED", APPROVE: "APPROVED_FIRST" },
    REVISION_REQUESTED: { FINAL_DRAFT: "FINAL_DRAFT_READY" },
    FINAL_DRAFT_READY: { APPROVE: "APPROVED_FINAL", DECLINE_FINAL: "CUSTOMER_DECLINED_FINAL" },
  };
  const next = transitions[state]?.[command];
  if (!next) throw new Error("Writing transition is unavailable");
  return next;
}
