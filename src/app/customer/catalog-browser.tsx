"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { CustomerListing } from "@/modules/catalog/domain";
import { CUSTOMER_CONTENT_POLICY } from "@/modules/orders/content-policy";

type ItemDraft = {
  targetUrl: string;
  anchorText: string;
  instructions: string;
  articleText: string;
  writingBrief: string;
  useWriting: boolean;
};
type SelectedItem = { listing: CustomerListing; draft: ItemDraft };

const emptyDraft = (): ItemDraft => ({ targetUrl: "", anchorText: "", instructions: "", articleText: "", writingBrief: "", useWriting: false });
const dollars = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const linkTypeLabel: Record<CustomerListing["linkType"], string> = { DOFOLLOW: "DoFollow", NOFOLLOW: "NoFollow", SPONSORED: "Sponsored", UGC: "UGC" };
const validityLabel: Record<CustomerListing["linkValidity"], string> = { PERMANENT: "Lifetime intent", FIVE_YEARS: "5 years", ONE_YEAR: "1 year", SIX_MONTHS: "6 months", THREE_MONTHS: "3 months" };

export function CatalogBrowser({ organizationId, listings }: { organizationId: string; listings: CustomerListing[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Record<string, SelectedItem>>({});
  const [sharedDetails, setSharedDetails] = useState({ targetUrl: "", anchorText: "", instructions: "", articleText: "", writingBrief: "" });
  const [consent, setConsent] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const listingById = new Map(listings.map((listing) => [listing.id, listing]));
  const selectedListings = Object.values(selected).map((item) => listingById.get(item.listing.id) ?? item.listing);
  const visibleIds = new Set(listings.map((listing) => listing.id));
  const offFilterSelected = selectedListings.filter((listing) => !visibleIds.has(listing.id));
  const total = selectedListings.reduce((sum, listing) => sum + listing.retailPriceCents + (selected[listing.id].draft.useWriting ? listing.writingPriceCents ?? 0 : 0), 0);

  function change(listingId: string, field: keyof ItemDraft, value: string | boolean) {
    idempotencyKey.current = "";
    setSelected((current) => ({ ...current, [listingId]: { ...current[listingId], draft: { ...current[listingId].draft, [field]: value } } }));
  }

  function toggle(listingId: string, checked: boolean) {
    idempotencyKey.current = "";
    setError("");
    if (checked && !selected[listingId] && Object.keys(selected).length >= 25) {
      setError("An order can include up to 25 different listings.");
      return;
    }
    setSelected((current) => {
      if (!checked) {
        const next = { ...current };
        delete next[listingId];
        return next;
      }
      const listing = listings.find((item) => item.id === listingId);
      return listing ? { ...current, [listingId]: { listing, draft: emptyDraft() } } : current;
    });
  }

  function copySharedDetails() {
    idempotencyKey.current = "";
    setSelected((current) => {
      const next = { ...current };
      for (const listing of selectedListings) {
        const selectedItem = next[listing.id];
        if (!selectedItem) continue;
        const draft = selectedItem.draft;
        next[listing.id] = {
          ...selectedItem,
          draft: { ...draft,
            targetUrl: sharedDetails.targetUrl,
            anchorText: sharedDetails.anchorText,
            instructions: sharedDetails.instructions,
            ...(draft.useWriting ? { writingBrief: sharedDetails.writingBrief } : { articleText: sharedDetails.articleText }),
          },
        };
      }
      return next;
    });
  }

  async function checkout() {
    setError("");
    if (!selectedListings.length) { setError("Select at least one website to continue."); return; }
    if (!policyAccepted) { setError("Review and accept the content policy to continue."); return; }
    if (!consent) { setError("Confirm the content rights and publication-partner notice to continue."); return; }
    for (const listing of selectedListings) {
      const item = selected[listing.id].draft;
      if (!item.targetUrl.trim() || !item.anchorText.trim() || (item.useWriting ? !item.writingBrief.trim() : !item.articleText.trim())) {
        setError(`Complete the destination URL, anchor text, and ${item.useWriting ? "writing brief" : "article"} for “${listing.title}”.`);
        return;
      }
    }
    setBusy(true);
    idempotencyKey.current ||= window.crypto.randomUUID();
    try {
      const response = await fetch("/api/customer/orders", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          order: {
            idempotencyKey: idempotencyKey.current,
            acceptContentPolicy: policyAccepted,
            items: selectedListings.map((listing) => {
              const item = selected[listing.id].draft;
              return {
                listingId: listing.id,
                expectedRevision: listing.revision,
                targetUrl: item.targetUrl.trim(),
                anchorText: item.anchorText.trim(),
                instructions: item.instructions.trim(),
                ...(item.useWriting ? { useWriting: true, writingBrief: item.writingBrief.trim() } : { articleText: item.articleText.trim() }),
                shareWithPublicationPartner: true,
              };
            }),
          },
        }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "Order could not be completed.");
      idempotencyKey.current = "";
      router.push(`/customer/orders?organizationId=${encodeURIComponent(organizationId)}&placed=1`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Order could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="catalogGrid">
        {listings.map((listing) => {
          const item = selected[listing.id]?.draft;
          return (
            <article className="catalogCard" key={listing.id}>
              <div className="catalogCardTop">
                <label className="catalogSelect">
                  <input type="checkbox" checked={Boolean(item)} onChange={(event) => toggle(listing.id, event.currentTarget.checked)} aria-label={`Add ${listing.title} to order`} />
                  <span>Select</span>
                </label>
                <div className="catalogPrice">{dollars(listing.retailPriceCents)}<span> per placement</span></div>
              </div>
              <h2>{listing.title}</h2>
              <p className="catalogDescription">{listing.description}</p>
              {listing.websiteUrl ? <p className="catalogSite"><a href={listing.websiteUrl} target="_blank" rel="noreferrer">{new URL(listing.websiteUrl).hostname}</a></p> : <p className="catalogHiddenSite">Website address hidden until wallet access is loaded</p>}
              <dl className="catalogTerms">
                <div><dt>Categories</dt><dd>{listing.categories.join(", ")}</dd></div>
                <div><dt>Language and region</dt><dd>{listing.primaryLanguage} · {listing.countryCode}</dd></div>
                <div><dt>Link and placement term</dt><dd>{linkTypeLabel[listing.linkType]} · {validityLabel[listing.linkValidity]}</dd></div>
                <div><dt>Placement availability</dt><dd>The stated term describes the publisher&apos;s intent and is not a guarantee that the link will remain available. After we verify a completed placement, GPHKM does not offer a replacement or refund if it later disappears.</dd></div>
                <div><dt>Turnaround</dt><dd>About {listing.turnaroundDays} days</dd></div>
                <div><dt>Placement permissions</dt><dd>Sports and gaming: {listing.allowsSportsAndGaming ? "Allowed" : "Not allowed"}; pharmacy: {listing.allowsPharmacy ? "Allowed" : "Not allowed"}; crypto: {listing.allowsCrypto ? "Allowed" : "Not allowed"}; foreign-language content: {listing.allowsForeignLanguage ? "Allowed" : "Not allowed"}; sponsored marking: {listing.sponsoredContentMarking ? "Required" : "Not required"}</dd></div>
                {listing.metrics.map((metric) => <div key={`${metric.provider}-${metric.metricScope}-${metric.observedOn}`}><dt>{metric.provider.replaceAll("_", " ")} ({metric.metricScope === "HOST" ? "site host" : "registered domain"})</dt><dd>{metric.value ?? "—"} · {metric.attributionText}</dd></div>)}
              </dl>
              {listing.buyerRequirements && <details className="catalogRequirements"><summary>Read placement requirements</summary><p>{listing.buyerRequirements}</p></details>}
              {item && (
                <div className="catalogItemDetails">
                  <label>Destination URL<input type="url" required maxLength={2048} value={item.targetUrl} onChange={(event) => change(listing.id, "targetUrl", event.currentTarget.value)} placeholder="https://your-site.com/page" /></label>
                  <label>Anchor text<input required maxLength={200} value={item.anchorText} onChange={(event) => change(listing.id, "anchorText", event.currentTarget.value)} /></label>
                  {listing.writingEnabled && <label className="catalogWriting"><input type="checkbox" checked={item.useWriting} onChange={(event) => change(listing.id, "useWriting", event.currentTarget.checked)} /> Add GPHKM Writing ({dollars(listing.writingPriceCents ?? 0)}) · about {listing.writingTurnaroundDays} days</label>}
                  {item.useWriting ? (
                    <>
                      <p className="catalogStageText">Writing stages: complete first draft {dollars(listing.writingFirstDraftCents ?? 0)}; final draft after your included revision {dollars(listing.writingFinalDraftCents ?? 0)}. A delivered stage is earned; only undelivered stages may be credited if cancellation is approved under the disclosed policy. Approving the first draft completes both stages. You review and approve the draft before publication instructions are prepared.</p>
                      <label>Writing brief<textarea required maxLength={4000} rows={4} value={item.writingBrief} onChange={(event) => change(listing.id, "writingBrief", event.currentTarget.value)} /></label>
                    </>
                  ) : <label>Article<textarea required maxLength={20000} rows={7} value={item.articleText} onChange={(event) => change(listing.id, "articleText", event.currentTarget.value)} /></label>}
                  <label>Additional publication instructions (optional)<textarea maxLength={4000} rows={3} value={item.instructions} onChange={(event) => change(listing.id, "instructions", event.currentTarget.value)} /></label>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {selectedListings.length > 0 && (
        <section className="catalogCheckout" aria-label="Selected placements">
          <div><strong>{selectedListings.length} selected</strong><span> Estimated total {dollars(total)}</span><small>Final amount is checked against current listing prices and available wallet funds.</small>
            <ul>{selectedListings.map((listing) => <li key={listing.id}>{listing.title}: {validityLabel[listing.linkValidity]} placement. The stated term is intent only; after verified completion, no replacement or refund is available if the link later disappears.{selected[listing.id].draft.useWriting && ` GPHKM Writing (${dollars(listing.writingPriceCents ?? 0)}): first draft ${dollars(listing.writingFirstDraftCents ?? 0)}, final draft ${dollars(listing.writingFinalDraftCents ?? 0)}; delivered stages are earned and only undelivered stages may be credited under the cancellation policy.`}</li>)}</ul>
          </div>
          <details className="catalogCopyDetails">
            <summary>Copy shared details across selected placements</summary>
            <p>Copy text to each selected item, then review and edit its details separately.</p>
            <div className="catalogSharedGrid">
              <label>Shared destination URL<input type="url" maxLength={2048} value={sharedDetails.targetUrl} onChange={(event) => setSharedDetails((current) => ({ ...current, targetUrl: event.currentTarget.value }))} /></label>
              <label>Shared anchor text<input maxLength={200} value={sharedDetails.anchorText} onChange={(event) => setSharedDetails((current) => ({ ...current, anchorText: event.currentTarget.value }))} /></label>
              <label>Shared publication instructions<textarea maxLength={4000} rows={3} value={sharedDetails.instructions} onChange={(event) => setSharedDetails((current) => ({ ...current, instructions: event.currentTarget.value }))} /></label>
              <label>Shared article<textarea maxLength={20000} rows={3} value={sharedDetails.articleText} onChange={(event) => setSharedDetails((current) => ({ ...current, articleText: event.currentTarget.value }))} /></label>
              <label>Shared writing brief<textarea maxLength={4000} rows={3} value={sharedDetails.writingBrief} onChange={(event) => setSharedDetails((current) => ({ ...current, writingBrief: event.currentTarget.value }))} /></label>
            </div>
            <button type="button" className="catalogCopyButton" onClick={copySharedDetails}>Copy into selected items</button>
          </details>
          {offFilterSelected.length > 0 && <div className="catalogOffFilterItems"><h3>Selected items outside the current search</h3><p>These remain in your order. Review or edit them here before checkout.</p>
            {offFilterSelected.map((listing) => {
              const item = selected[listing.id].draft;
              return <fieldset className="catalogOffFilterItem" key={listing.id}><legend>{listing.title}</legend>
                <p>{validityLabel[listing.linkValidity]} placement. The stated term describes intent, not a guarantee. No replacement or refund is available after verified completion if a link later disappears.</p>
                <button type="button" className="catalogRemoveButton" onClick={() => toggle(listing.id, false)}>Remove from order</button>
                <label>Destination URL<input type="url" required maxLength={2048} value={item.targetUrl} onChange={(event) => change(listing.id, "targetUrl", event.currentTarget.value)} /></label>
                <label>Anchor text<input required maxLength={200} value={item.anchorText} onChange={(event) => change(listing.id, "anchorText", event.currentTarget.value)} /></label>
                {listing.writingEnabled && <label className="catalogWriting"><input type="checkbox" checked={item.useWriting} onChange={(event) => change(listing.id, "useWriting", event.currentTarget.checked)} /> Add GPHKM Writing ({dollars(listing.writingPriceCents ?? 0)}) · about {listing.writingTurnaroundDays} days</label>}
                {item.useWriting ? <><p>Stages: first draft {dollars(listing.writingFirstDraftCents ?? 0)}; final draft {dollars(listing.writingFinalDraftCents ?? 0)}. Delivered stages are earned; only undelivered stages may be credited under the disclosed cancellation policy.</p><label>Writing brief<textarea required maxLength={4000} rows={4} value={item.writingBrief} onChange={(event) => change(listing.id, "writingBrief", event.currentTarget.value)} /></label></>
                  : <label>Article<textarea required maxLength={20000} rows={5} value={item.articleText} onChange={(event) => change(listing.id, "articleText", event.currentTarget.value)} /></label>}
                <label>Additional publication instructions (optional)<textarea maxLength={4000} rows={3} value={item.instructions} onChange={(event) => change(listing.id, "instructions", event.currentTarget.value)} /></label>
              </fieldset>;
            })}
          </div>}
          <section className="catalogPolicy" aria-labelledby="content-policy-heading">
            <h3 id="content-policy-heading">Content policy</h3>
            <details>
              <summary>Read the content rules</summary>
              <ul>{CUSTOMER_CONTENT_POLICY.map((rule) => <li key={rule}>{rule}</li>)}</ul>
              <p>These rules work alongside each listing&apos;s requirements shown above.</p>
            </details>
            <label className="catalogConsent"><input type="checkbox" checked={policyAccepted} onChange={(event) => { setPolicyAccepted(event.currentTarget.checked); idempotencyKey.current = ""; }} /> I have the rights needed to submit this content and links, and I agree to follow the GPHKM content policy.</label>
            <label className="catalogConsent"><input type="checkbox" checked={consent} onChange={(event) => { setConsent(event.currentTarget.checked); idempotencyKey.current = ""; }} /> I understand that the approved article or brief, destination URL, anchor text, and necessary instructions will be shared with the publication partner to fulfill each placement.</label>
          </section>
          {error && <p ref={errorRef} role="alert" tabIndex={-1} className="catalogError">{error}</p>}
          <button type="button" disabled={busy} onClick={checkout}>{busy ? "Placing order…" : `Place order · ${dollars(total)}`}</button>
        </section>
      )}
      {error && selectedListings.length === 0 && <p ref={errorRef} role="alert" tabIndex={-1} className="catalogError">{error}</p>}
    </>
  );
}

export function CatalogFilters({ organizationId, search, category, country, language, doFollowOnly, categories, languages }: {
  organizationId: string; search: string; category: string; country: string; language: string; doFollowOnly: boolean;
  categories: readonly string[]; languages: readonly string[];
}) {
  const router = useRouter();
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams({ organizationId });
    const query = String(data.get("q") ?? "").trim();
    const selectedCategory = String(data.get("category") ?? "");
    const selectedCountry = String(data.get("country") ?? "").trim().toUpperCase();
    const selectedLanguage = String(data.get("language") ?? "");
    if (query) params.set("q", query);
    if (selectedCategory) params.set("category", selectedCategory);
    if (selectedCountry) params.set("country", selectedCountry);
    if (selectedLanguage) params.set("language", selectedLanguage);
    if (data.get("doFollowOnly") === "on") params.set("doFollowOnly", "1");
    router.push(`/customer/catalog?${params.toString()}`);
  }
  return <form className="catalogFilters" onSubmit={apply}>
    <input type="hidden" name="organizationId" value={organizationId} />
    <label>Search websites<input name="q" maxLength={100} defaultValue={search} placeholder="Name or description" /></label>
    <label>Category<select name="category" defaultValue={category}>
      <option value="">All categories</option>
      {categories.map((value) => <option value={value} key={value}>{value}</option>)}
    </select></label>
    <label>Country / region code<input name="country" maxLength={2} pattern="[A-Za-z]{2}" title="Use a two-letter code, such as US" defaultValue={country} placeholder="US" autoCapitalize="characters" /></label>
    <label>Primary language<select name="language" defaultValue={language}>
      <option value="">All languages</option>
      {languages.map((value) => <option value={value} key={value}>{value}</option>)}
    </select></label>
    <label className="catalogDoFollowFilter"><input type="checkbox" name="doFollowOnly" defaultChecked={doFollowOnly} /> DoFollow only</label>
    <button type="submit">Search</button>
    {(search || category || country || language || doFollowOnly) && <Link href={`/customer/catalog?organizationId=${encodeURIComponent(organizationId)}`}>Clear</Link>}
  </form>;
}

export function CatalogPagination({ organizationId, search, category, country, language, doFollowOnly, page, pageCount, total }: {
  organizationId: string; search: string; category: string; country: string; language: string; doFollowOnly: boolean;
  page: number; pageCount: number; total: number;
}) {
  if (pageCount <= 1) return null;
  function pageHref(nextPage: number) {
    const params = new URLSearchParams({ organizationId, page: String(nextPage) });
    if (search) params.set("q", search);
    if (category) params.set("category", category);
    if (country) params.set("country", country);
    if (language) params.set("language", language);
    if (doFollowOnly) params.set("doFollowOnly", "1");
    return `/customer/catalog?${params.toString()}`;
  }
  return <nav className="catalogPagination" aria-label="Marketplace pages">
    {page > 1 ? <Link href={pageHref(page - 1)}>Previous</Link> : <span aria-disabled="true">Previous</span>}
    <span>Page {page} of {pageCount} · {total.toLocaleString("en-US")} websites</span>
    {page < pageCount ? <Link href={pageHref(page + 1)}>Next</Link> : <span aria-disabled="true">Next</span>}
  </nav>;
}
