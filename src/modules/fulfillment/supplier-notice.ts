export type SupplierNoticeType = "WITHDRAWAL" | "CORRECTION";

export function buildSupplierNotice(type: SupplierNoticeType, reference: string, reason: string) {
  const cleanReference = reference.trim();
  const cleanReason = reason.trim();
  if (!["WITHDRAWAL", "CORRECTION"].includes(type) || cleanReference.length < 3 || cleanReference.length > 100 ||
      cleanReason.length < 5 || cleanReason.length > 1000 || /[\u0000-\u001f\u007f]/.test(cleanReference + cleanReason)) {
    throw new Error("Supplier notice details are invalid");
  }
  const subject = type === "WITHDRAWAL" ? `GPHKM ${cleanReference}: request to stop/withdraw work` : `GPHKM ${cleanReference}: placement correction`;
  const body = type === "WITHDRAWAL"
    ? `GPHKM notice for ${cleanReference}. Please stop work and withdraw or cancel this placement if still possible.\n\nReason: ${cleanReason}\n\nPlease reply to confirm what action was taken. This request does not mean the work has stopped; GPHKM will record your confirmation separately.`
    : `GPHKM notice for ${cleanReference}. Please make the following correction to this placement if still possible.\n\nCorrection: ${cleanReason}\n\nPlease reply to confirm whether this change can be made. Sending this notice does not confirm that work has stopped or that the correction is complete.`;
  return { subject, body, itemReference: cleanReference };
}

function safeHeader(value: string) { return value.replace(/[\r\n\0]/g, " ").trim(); }
export function renderSupplierNoticeEml(input: { recipient: string; subject: string; body: string }) {
  const encoded = Buffer.from(input.body, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return `To: ${safeHeader(input.recipient)}\r\nSubject: ${safeHeader(input.subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}`;
}
