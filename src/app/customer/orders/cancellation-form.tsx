import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { getCustomerOrderItemCancellations } from "@/server/orders/cancellation";
import { cancellationCustomerMessage } from "@/modules/orders/cancellation";
import { requestOrderItemCancellationAction } from "./cancellation-actions";

function money(minor: string) {
  const amount = BigInt(minor);
  return `$${(amount / 100n).toLocaleString("en-US")}.${(amount % 100n).toString().padStart(2, "0")}`;
}

export async function OrderItemCancellationForm(props: { organizationId: string; itemId: string }) {
  const { history, canRequest } = await getCustomerOrderItemCancellations(await headers(), props.organizationId, props.itemId);
  const latest = history.at(-1);
  return (
    <section aria-label="Cancellation request">
      {history.length > 0 && <div>
        <h4>Cancellation request history</h4>
        <ol>
          {history.map((request) => <li key={request.id}>
            <p><strong>{cancellationCustomerMessage(request.state)}</strong> <time dateTime={request.requestedAt.toISOString()}>{request.requestedAt.toLocaleDateString("en-US", { dateStyle: "medium" })}</time></p>
            <p>Your reason: {request.reason}</p>
            {request.decisionReason && <p>Review update: {request.decisionReason}</p>}
            {request.state === "APPROVED" && <p>Wallet credit: {money(request.refundMinor)}</p>}
          </li>)}
        </ol>
      </div>}
      {canRequest && latest?.state !== "APPROVED" && latest?.state !== "REQUESTED" && <details>
        <summary>Request item cancellation</summary>
        <p>Requests are reviewed by GPHKM. If approved before fulfillment starts, eligible undelivered amounts are credited to your organization wallet.</p>
        <form action={requestOrderItemCancellationAction}>
          <input type="hidden" name="organizationId" value={props.organizationId} />
          <input type="hidden" name="itemId" value={props.itemId} />
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>
            Reason for cancellation
            <textarea name="reason" required minLength={1} maxLength={2000} rows={3} />
          </label>
          <button type="submit">Send cancellation request</button>
        </form>
      </details>}
    </section>
  );
}
