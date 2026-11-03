export function assertSupplierOutcomeMayBeRecorded(state: string): void {
  if (state === "CANCELLATION_REQUESTED") {
    throw new Error("Resolve the pending cancellation request before recording a supplier outcome");
  }
}
