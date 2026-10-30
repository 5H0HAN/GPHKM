import { decideEquivalentOfferAction } from "./equivalent-offer-actions";

type Offer = {
  id: string; orderItemId: string; title: string; websiteUrl: string; description: string;
  equivalenceNote: string; categories: string[]; countryCode: string; language: string;
  linkType: string; linkValidity: string; turnaroundDays: number; buyerRequirements: string | null;
  sponsoredContentMarking: boolean; lockedPriceMinor: string; status: string; canDecide: boolean;
  createdAt: Date;
};

function money(minor: string) {
  const value = BigInt(minor);
  return `$${(value / 100n).toLocaleString("en-US")}.${(value % 100n).toString().padStart(2, "0")}`;
}

export function EquivalentOfferCard({ offer, organizationId }: { offer: Offer; organizationId: string }) {
  const label = offer.status === "OFFERED" ? "Awaiting your decision" : offer.status === "ACCEPTED" ? "Approved" : "Declined";
  return <section className="customerWritingReview" aria-labelledby={`equivalent-${offer.id}`}>
    <h4 id={`equivalent-${offer.id}`}>Alternative placement option · {label}</h4>
    <p>{offer.equivalenceNote}</p>
    <h5>{offer.title}</h5>
    <p><a href={offer.websiteUrl} target="_blank" rel="noreferrer">{offer.websiteUrl}</a></p>
    <p>{offer.description}</p>
    <dl>
      <div><dt>Categories</dt><dd>{offer.categories.join(", ")}</dd></div>
      <div><dt>Region and language</dt><dd>{offer.countryCode} · {offer.language}</dd></div>
      <div><dt>Link type and term</dt><dd>{offer.linkType} · {offer.linkValidity}</dd></div>
      <div><dt>Turnaround estimate</dt><dd>{offer.turnaroundDays} days</dd></div>
      <div><dt>Sponsored marking</dt><dd>{offer.sponsoredContentMarking ? "Required" : "Not listed"}</dd></div>
      {offer.buyerRequirements && <div><dt>Requirements</dt><dd>{offer.buyerRequirements}</dd></div>}
      <div><dt>Your existing order price</dt><dd><strong>{money(offer.lockedPriceMinor)}</strong></dd></div>
    </dl>
    {offer.status === "OFFERED" && offer.canDecide && <>
      <p>Review the site and terms. If you approve, the price stays the same. GPHKM will share the article, destination URL, anchor text, and necessary placement instructions with this publication partner. Supplier identity and internal sourcing remain private.</p>
      <form action={decideEquivalentOfferAction}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="offerId" value={offer.id} />
        <input type="hidden" name="decision" value="ACCEPT" />
        <label><input type="checkbox" name="shareConsent" value="yes" required /> I approve this option and consent to sharing the order content and instructions above with this publication partner.</label>
        <button type="submit">Approve alternative at the same price</button>
      </form>
      <form action={decideEquivalentOfferAction}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="offerId" value={offer.id} />
        <input type="hidden" name="decision" value="DECLINE" />
        <label>Reason (optional for GPHKM Support)<textarea name="reason" maxLength={1000} rows={2} /></label>
        <button type="submit">Decline this option</button>
      </form>
    </>}
  </section>;
}
