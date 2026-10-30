export type WritingCancellationState =
  | "WAITING_FOR_FIRST_DRAFT"
  | "FIRST_DRAFT_READY"
  | "REVISION_REQUESTED"
  | "FINAL_DRAFT_READY"
  | "APPROVED_FIRST"
  | "APPROVED_FINAL";

export type CancellationRefundInput = Readonly<{
  placementPriceMinor: string;
  writingSelected: boolean;
  writingFirstStageMinor: string;
  writingFinalStageMinor: string;
  writingState?: WritingCancellationState;
}>;

function minor(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid order amount");
  return BigInt(value);
}

/** Placement is undelivered before handoff. Writing fees are refunded by undelivered stage. */
export function calculatePreHandoffRefund(input: CancellationRefundInput): string {
  const placement = minor(input.placementPriceMinor);
  const first = minor(input.writingFirstStageMinor);
  const final = minor(input.writingFinalStageMinor);
  if (placement <= 0n || (!input.writingSelected && (first !== 0n || final !== 0n))) throw new Error("Invalid order amount");
  let writingRefund = 0n;
  if (input.writingSelected) {
    if (!input.writingState) throw new Error("Writing stage is unavailable");
    if (input.writingState === "WAITING_FOR_FIRST_DRAFT") writingRefund = first + final;
    else if (input.writingState === "FIRST_DRAFT_READY" || input.writingState === "REVISION_REQUESTED") writingRefund = final;
    // Final draft delivery, including approval of the first draft, completes both stages.
  }
  return (placement + writingRefund).toString();
}

export function cancellationCustomerMessage(state: string): string {
  switch (state) {
    case "REQUESTED": return "Your cancellation request is under review.";
    case "APPROVED": return "The item was canceled and the approved amount was returned to your organization wallet.";
    case "DENIED": return "Your cancellation request was reviewed. See the decision details or contact Support.";
    default: throw new Error("Cancellation status is unavailable");
  }
}
