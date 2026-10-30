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
const metricProviders: { provider: CustomerListing["metrics"][number]["provider"]; label: string; shortLabel: string }[] = [
  { provider: "OPEN_PAGE_RANK", label: "Open PageRank", shortLabel: "OPR" },
  { provider: "AHREFS_DR", label: "Ahrefs Domain Rating", shortLabel: "Ahrefs DR" },
  { provider: "MOZ_DA", label: "Moz Domain Authority", shortLabel: "Moz DA" },
];

function formatMetric(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function formatMetricDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

function metricScopeLabel(scope: CustomerListing["metrics"][number]["metricScope"]) {
  return scope === "HOST" ? "Host" : scope === "REGISTERED_DOMAIN" ? "Registered domain" : "Domain";
}

type CatalogFilterProps = {
  search: string; category: string; country: string; language: string; doFollowOnly: boolean;
  categories: readonly string[]; languages: readonly string[];
};
type CatalogPageProps = Omit<CatalogFilterProps, "categories" | "languages"> & { page: number; pageCount: number; total: number };

export function CatalogBrowser({ organizationId, listings, filterProps, pageProps }: {
  organizationId: string; listings: CustomerListing[]; filterProps: CatalogFilterProps; pageProps: CatalogPageProps;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"browse" | "details" | "review">("browse");
  const [selected, setSelected] = useState<Record<string, SelectedItem>>({});
  const [sharedDetails, setSharedDetails] = useState({ targetUrl: "", anchorText: "", instructions: "", articleText: "", writingBrief: "" });
  const [consent, setConsent] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const idempotencyKeyRef = useRef("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const catalogFlowHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (step !== "browse") catalogFlowHeadingRef.current?.focus(); }, [step]);
  const listingById = new Map(listings.map((listing) => [listing.id, listing]));
  const selectedListings = Object.values(selected).map((item) => listingById.get(item.listing.id) ?? item.listing);
  const total = selectedListings.reduce((sum, listing) => sum + listing.retailPriceCents + (selected[listing.id].draft.useWriting ? listing.writingPriceCents ?? 0 : 0), 0);

  function change(listingId: string, field: keyof ItemDraft, value: string | boolean) {
    idempotencyKeyRef.current = "";
    setSelected((current) => ({ ...current, [listingId]: { ...current[listingId], draft: { ...current[listingId].draft, [field]: value } } }));
  }

  function toggle(listingId: string, checked: boolean) {
    idempotencyKeyRef.current = "";
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

  function removeSelected(listingId: string) {
    idempotencyKeyRef.current = "";
    setError("");
    setSelected((current) => {
      const next = { ...current };
      delete next[listingId];
      return next;
    });
    if (Object.keys(selected).length <= 1) setStep("browse");
  }

  function copySharedDetails() {
    idempotencyKeyRef.current = "";
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

  function continueToReview() {
    setError("");
    if (!selectedListings.length) { setError("Select at least one website to continue."); return; }
    for (const listing of selectedListings) {
      const item = selected[listing.id].draft;
      if (!item.targetUrl.trim() || !item.anchorText.trim() || (item.useWriting ? !item.writingBrief.trim() : !item.articleText.trim())) {
        setError(`Complete the destination URL, anchor text, and ${item.useWriting ? "writing brief" : "article"} for “${listing.title}”.`);
        return;
      }
    }
    setStep("review");
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
    idempotencyKeyRef.current ||= window.crypto.randomUUID();
    try {
      const response = await fetch("/api/customer/orders", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          order: {
            idempotencyKey: idempotencyKeyRef.current,
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
      const result = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      if (result?.code === "LISTING_CHANGED" || result?.code === "LISTING_UNAVAILABLE") router.refresh();
      if (!response.ok) throw new Error(result?.error ?? "Order could not be completed.");
      idempotencyKeyRef.current = "";
      router.push(`/customer/orders?organizationId=${encodeURIComponent(organizationId)}&placed=1`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Order could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  const fields = (listing: CustomerListing) => {
    const item = selected[listing.id]?.draft;
    if (!item) return null;
    return <div className="catalogItemDetails">
      <label>Destination URL <span>Required</span><input type="url" required maxLength={2048} value={item.targetUrl} onChange={(event) => change(listing.id, "targetUrl", event.currentTarget.value)} placeholder="https://your-site.com/page" /></label>
      <label>Anchor text <span>Required</span><input required maxLength={200} value={item.anchorText} onChange={(event) => change(listing.id, "anchorText", event.currentTarget.value)} placeholder="Text that should link to your page" /></label>
      {listing.writingEnabled && <label className="catalogWriting"><input type="checkbox" checked={item.useWriting} onChange={(event) => change(listing.id, "useWriting", event.currentTarget.checked)} /> Add GPHKM Writing · {dollars(listing.writingPriceCents ?? 0)} · about {listing.writingTurnaroundDays} days</label>}
      {item.useWriting ? <><p className="catalogStageText">Writing has two disclosed stages: first draft {dollars(listing.writingFirstDraftCents ?? 0)} and final draft {dollars(listing.writingFinalDraftCents ?? 0)} after your included revision. Approving the first draft without a revision completes both stages. A delivered stage is earned; only undelivered stages may be credited if a cancellation is approved under the disclosed policy. You review and approve the draft before publication instructions are prepared.</p><label>Writing brief <span>Required</span><textarea required maxLength={4000} rows={5} value={item.writingBrief} onChange={(event) => change(listing.id, "writingBrief", event.currentTarget.value)} placeholder="Describe the topic, audience, and points to cover" /></label></>
        : <label>Article <span>Required</span><textarea required maxLength={20000} rows={8} value={item.articleText} onChange={(event) => change(listing.id, "articleText", event.currentTarget.value)} placeholder="Paste the article you want published" /></label>}
      <label>Additional publication instructions <span>Optional</span><textarea maxLength={4000} rows={3} value={item.instructions} onChange={(event) => change(listing.id, "instructions", event.currentTarget.value)} placeholder="Anything else needed for this placement" /></label>
    </div>;
  };

  const stepLabel = step === "browse" ? "Choose placements" : step === "details" ? "Add order details" : "Review order";
  return <>
    {step === "browse" && <>
      <CatalogFilters organizationId={organizationId} {...filterProps} />
      <CatalogPagination organizationId={organizationId} {...pageProps} />
      <div className="catalogGrid">
        {listings.map((listing) => {
          const item = selected[listing.id]?.draft;
          const presentMetrics = metricProviders.flatMap(({ provider, label, shortLabel }) => listing.metrics.filter((metric) => metric.provider === provider).map((metric) => ({ metric, label, shortLabel })));
          return <article className="catalogCard" key={listing.id}>
            <div className="catalogCardTop"><label className="catalogSelect"><input type="checkbox" checked={Boolean(item)} onChange={(event) => toggle(listing.id, event.currentTarget.checked)} aria-label={`${item ? "Remove" : "Add"} ${listing.title} ${item ? "from" : "to"} order`} /><span>{item ? "In your order" : "Add to order"}</span></label><div className="catalogPrice"><strong>{dollars(listing.retailPriceCents)}</strong><span>per placement</span></div></div>
            <div className="catalogIdentity"><span className="catalogDomainMark" aria-hidden="true">{listing.websiteUrl ? new URL(listing.websiteUrl).hostname.slice(0, 1).toUpperCase() : "G"}</span><div className="catalogIdentityText"><h2>{listing.title}</h2>{listing.websiteUrl ? <a className="catalogSite" href={listing.websiteUrl} target="_blank" rel="noreferrer">{new URL(listing.websiteUrl).hostname}<span aria-hidden="true">↗</span></a> : <span className="catalogHiddenSite">Website address hidden · revealed after a qualifying wallet recharge</span>}</div></div>
            <p className="catalogDescription">{listing.description}</p>
            <ul className="catalogCategories" aria-label="Website categories">{listing.categories.map((category) => <li key={category}>{category}</li>)}</ul>
            <div className="catalogQuickFacts" aria-label="Placement overview"><div><span>Language &amp; region</span><strong>{listing.primaryLanguage} · {listing.countryCode}</strong></div><div><span>Link type</span><strong>{linkTypeLabel[listing.linkType]}</strong></div><div><span>Placement term</span><strong>{validityLabel[listing.linkValidity]}</strong></div><div><span>Turnaround</span><strong>About {listing.turnaroundDays} days</strong></div></div>
            <section className="catalogMetrics" aria-label="Approved domain metrics"><div className="catalogMetricsHeader"><h3>Domain metrics</h3><span>Source-attributed observations</span></div>{presentMetrics.length ? <div className="catalogMetricGrid">{presentMetrics.map(({ metric, label, shortLabel }) => <div className="catalogMetric" key={`${metric.provider}-${metric.metricScope}-${metric.observedOn}-${metric.value}`}><span className="catalogMetricLabel" title={label}>{shortLabel}</span><div className="catalogMetricReading"><strong>{metric.value === null ? "—" : formatMetric(metric.value)}</strong><small>{metricScopeLabel(metric.metricScope)}{formatMetricDate(metric.observedOn) ? ` · ${formatMetricDate(metric.observedOn)}` : ""}</small>{metric.attributionText && <span>{metric.attributionText}</span>}</div></div>)}</div> : <p className="catalogNoMetrics">No approved domain metrics are available for this listing yet.</p>}</section>
            <details className="catalogMore"><summary>Placement details &amp; requirements</summary><dl className="catalogTerms"><div><dt>Sports and gaming</dt><dd>{listing.allowsSportsAndGaming ? "Allowed" : "Not allowed"}</dd></div><div><dt>Pharmacy</dt><dd>{listing.allowsPharmacy ? "Allowed" : "Not allowed"}</dd></div><div><dt>Crypto</dt><dd>{listing.allowsCrypto ? "Allowed" : "Not allowed"}</dd></div><div><dt>Foreign-language content</dt><dd>{listing.allowsForeignLanguage ? "Allowed" : "Not allowed"}</dd></div><div><dt>Sponsored marking</dt><dd>{listing.sponsoredContentMarking ? "Required" : "Not required"}</dd></div><div className="catalogTermsWide"><dt>Placement availability</dt><dd>The stated term describes the publisher&apos;s intent and is not a guarantee that the link will remain available. After verified completion, GPHKM does not offer a replacement or refund if it later disappears.</dd></div></dl>{listing.buyerRequirements && <div className="catalogRequirements"><h4>Buyer requirements</h4><p>{listing.buyerRequirements}</p></div>}</details>
          </article>;
        })}
      </div>
      {selectedListings.length > 0 && <section className="catalogOrderTray" aria-label="Selected placements"><div><strong>{selectedListings.length} of 25 placements</strong><span>{dollars(total)} estimated</span></div><p>Listing details and final wallet availability are checked again before the order is placed.</p><button type="button" onClick={() => { setError(""); setStep("details"); }}>Add order details <span aria-hidden="true">→</span></button></section>}
      {error && <p ref={errorRef} role="alert" tabIndex={-1} className="catalogError">{error}</p>}
    </>}

    {step !== "browse" && <section className="catalogFlow" aria-labelledby="catalog-flow-heading">
      <nav className="catalogStepNav" aria-label="Order progress"><span>1 <span>Choose placements</span></span><span aria-current={step === "details" ? "step" : undefined}>2 <span>Add order details</span></span><span aria-current={step === "review" ? "step" : undefined}>3 <span>Review order</span></span></nav>
      <header className="catalogFlowHeader"><div><p className="catalogFlowCount">{selectedListings.length} placement{selectedListings.length === 1 ? "" : "s"} · {dollars(total)} estimated</p><h2 id="catalog-flow-heading" ref={catalogFlowHeadingRef} tabIndex={-1}>{stepLabel}</h2><p>{step === "details" ? "Add one destination and anchor per placement. Your text stays editable until you place the order." : "Check every placement, the estimated total, and the content-sharing terms before placing the order."}</p></div><button type="button" className="catalogSecondaryButton" onClick={() => setStep("browse")}>Back to marketplace</button></header>
      {step === "details" ? <>
        <details className="catalogCopyDetails"><summary>Copy shared details across selected placements</summary><p>Copy text into each selected item, then review and edit it separately. Article text only copies to placements using customer-supplied content.</p><div className="catalogSharedGrid"><label>Shared destination URL<input type="url" maxLength={2048} value={sharedDetails.targetUrl} onChange={(event) => setSharedDetails((current) => ({ ...current, targetUrl: event.currentTarget.value }))} /></label><label>Shared anchor text<input maxLength={200} value={sharedDetails.anchorText} onChange={(event) => setSharedDetails((current) => ({ ...current, anchorText: event.currentTarget.value }))} /></label><label>Shared publication instructions<textarea maxLength={4000} rows={3} value={sharedDetails.instructions} onChange={(event) => setSharedDetails((current) => ({ ...current, instructions: event.currentTarget.value }))} /></label><label>Shared article<textarea maxLength={20000} rows={3} value={sharedDetails.articleText} onChange={(event) => setSharedDetails((current) => ({ ...current, articleText: event.currentTarget.value }))} /></label><label>Shared writing brief<textarea maxLength={4000} rows={3} value={sharedDetails.writingBrief} onChange={(event) => setSharedDetails((current) => ({ ...current, writingBrief: event.currentTarget.value }))} /></label></div><button type="button" className="catalogCopyButton" onClick={copySharedDetails}>Copy into selected placements</button></details>
        <div className="catalogOrderItems">{selectedListings.map((listing, index) => <article className="catalogOrderItem" key={listing.id}><header><span className="catalogItemNumber">Placement {index + 1}</span><div><h3>{listing.title}</h3><p>{listing.categories.join(" · ")}</p><button type="button" className="catalogItemRemove" onClick={() => removeSelected(listing.id)}>Remove from order</button></div><strong>{dollars(listing.retailPriceCents + (selected[listing.id].draft.useWriting ? listing.writingPriceCents ?? 0 : 0))}</strong></header>{fields(listing)}</article>)}</div>
        {error && <p ref={errorRef} role="alert" tabIndex={-1} className="catalogError">{error}</p>}
        <div className="catalogFlowActions"><button type="button" className="catalogPrimaryButton" onClick={continueToReview}>Review order <span aria-hidden="true">→</span></button></div>
      </> : <>
        <div className="catalogReviewList">{selectedListings.map((listing) => { const item = selected[listing.id].draft; return <article key={listing.id}><div><h3>{listing.title}</h3><p>{item.useWriting ? "GPHKM Writing" : "Customer-provided article"} · {validityLabel[listing.linkValidity]} placement</p><p className="catalogReviewDestination">Destination: {item.targetUrl}</p><p>Anchor text: {item.anchorText}</p><details className="catalogReviewContent"><summary>Review {item.useWriting ? "writing brief" : "article"}{item.instructions.trim() ? " and instructions" : ""}</summary><pre>{item.useWriting ? item.writingBrief : item.articleText}</pre>{item.instructions.trim() && <><strong>Additional publication instructions</strong><pre>{item.instructions}</pre></>}</details></div><strong>{dollars(listing.retailPriceCents + (item.useWriting ? listing.writingPriceCents ?? 0 : 0))}</strong></article>; })}</div>
        <p className="catalogReviewNotice">Estimated total <strong>{dollars(total)}</strong>. Final amount is checked against current listing prices and available wallet funds. A completed placement has no replacement or refund if its link later disappears.</p>
        <section className="catalogPolicy" aria-labelledby="content-policy-heading"><h3 id="content-policy-heading">Content policy &amp; sharing</h3><details><summary>Read the content rules</summary><ul>{CUSTOMER_CONTENT_POLICY.map((rule) => <li key={rule}>{rule}</li>)}</ul><p>These rules work alongside each listing&apos;s requirements.</p></details><label className="catalogConsent"><input type="checkbox" checked={policyAccepted} onChange={(event) => { setPolicyAccepted(event.currentTarget.checked); idempotencyKeyRef.current = ""; }} /> I have the rights needed to submit this content and links, and I agree to follow the GPHKM content policy.</label><label className="catalogConsent"><input type="checkbox" checked={consent} onChange={(event) => { setConsent(event.currentTarget.checked); idempotencyKeyRef.current = ""; }} /> I understand the approved article or brief, destination URL, anchor text, and necessary instructions will be shared with the publication partner to fulfill each placement.</label></section>
        {error && <p ref={errorRef} role="alert" tabIndex={-1} className="catalogError">{error}</p>}
        <div className="catalogFlowActions catalogReviewActions"><button type="button" className="catalogSecondaryButton" onClick={() => setStep("details")}>Back to details</button><button type="button" className="catalogPrimaryButton" disabled={busy} onClick={checkout}>{busy ? "Placing order…" : `Place order · ${dollars(total)}`}</button></div>
      </>}
    </section>}
  </>;
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
