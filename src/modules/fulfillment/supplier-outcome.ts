export function assertSupplierOutcomeMayBeRecorded(state: string): void {
  if (state === "CANCELLATION_REQUESTED") {
    throw new Error("Resolve the pending cancellation request before recording a supplier outcome");
  }
}

export function normalizeSupplierRecoveryReason(input: string): string {
  const reason = input.replace(/[\t\r\n]+/g, " ").trim();
  if (reason.length < 5 || reason.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(reason)) {
    throw new Error("Add a valid internal recovery reason");
  }
  return reason;
}
