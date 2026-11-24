"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { CustomerListing } from "@/modules/catalog/domain";
import { CHECKOUT_DISCLOSURES } from "@/modules/orders/checkout";
import { CUSTOMER_CONTENT_POLICY } from "@/modules/orders/content-policy";

type ItemDraft = {
  targetUrl: string;
  anchorText: string;
  instructions: string;
  articleText: string;
  writingBrief: string;
  useWriting: boolean;
};
type SelectedItem = { listing?: CustomerListing; listingRevision: number; version: number; generationId: string | null; draft: ItemDraft; unavailable?: boolean };
type SelectedItems = Record<string, SelectedItem>;

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

function ListingRequirements({ listing, showOverview = false }: { listing: CustomerListing; showOverview?: boolean }) {
  return <details className="catalogMore">
    <summary>Placement details &amp; requirements</summary>
    <dl className="catalogTerms">
      {showOverview && <>
        <div><dt>Placement term</dt><dd>{validityLabel[listing.linkValidity]}</dd></div>
        <div><dt>Link type</dt><dd>{linkTypeLabel[listing.linkType]}</dd></div>
        <div><dt>Turnaround</dt><dd>About {listing.turnaroundDays} days</dd></div>
        <div><dt>Language and region</dt><dd>{listing.primaryLanguage} · {listing.countryCode}</dd></div>
      </>}
      <div><dt>Sports and gaming</dt><dd>{listing.allowsSportsAndGaming ? "Allowed" : "Not allowed"}</dd></div>
      <div><dt>Pharmacy</dt><dd>{listing.allowsPharmacy ? "Allowed" : "Not allowed"}</dd></div>
      <div><dt>Crypto</dt><dd>{listing.allowsCrypto ? "Allowed" : "Not allowed"}</dd></div>
      <div><dt>Foreign-language content</dt><dd>{listing.allowsForeignLanguage ? "Allowed" : "Not allowed"}</dd></div>
      <div><dt>Sponsored marking</dt><dd>{listing.sponsoredContentMarking ? "Required" : "Not required"}</dd></div>
      <div className="catalogTermsWide"><dt>Placement availability</dt><dd>The stated term describes the publisher&apos;s intent and is not a guarantee that the link will remain available. After verified completion, GPHKM does not offer a replacement or refund if it later disappears.</dd></div>
    </dl>
    {listing.buyerRequirements && <div className="catalogRequirements"><h4>Buyer requirements</h4><p>{listing.buyerRequirements}</p></div>}
  </details>;
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
  const [stepForOrganization, setStepForOrganization] = useState<{ organizationId: string; step: "browse" | "details" | "review" }>({ organizationId, step: "browse" });
  const step = stepForOrganization.organizationId === organizationId ? stepForOrganization.step : "browse";
  function setStep(nextStep: "browse" | "details" | "review") { setStepForOrganization({ organizationId, step: nextStep }); }
  const [selectedForOrganization, setSelectedForOrganization] = useState<{ organizationId: string; items: SelectedItems }>({ organizationId, items: {} });
  const selected = useMemo(() => selectedForOrganization.organizationId === organizationId ? selectedForOrganization.items : {}, [organizationId, selectedForOrganization]);
  const setSelected = useCallback((action: SelectedItems | ((current: SelectedItems) => SelectedItems)) => {
    setSelectedForOrganization((current) => ({
      organizationId,
      items: typeof action === "function"
        ? action(current.organizationId === organizationId ? current.items : {})
        : action,
    }));
  }, [organizationId]);
  const [cartLoadedOrganization, setCartLoadedOrganization] = useState<string | null>(null);
  const cartLoaded = cartLoadedOrganization === organizationId;
  const [cartErrorState, setCartErrorState] = useState({ organizationId, message: "" });
  const cartError = cartErrorState.organizationId === organizationId ? cartErrorState.message : "";
  const setCartError = useCallback((message: string) => { setCartErrorState({ organizationId, message }); }, [organizationId]);
  const [cartSaveState, setCartSaveState] = useState<"saved" | "saving">("saved");
  const [cartBusy, setCartBusy] = useState(false);
  const [confirmClearCart, setConfirmClearCart] = useState(false);
  const [sharedDetails, setSharedDetails] = useState({ targetUrl: "", anchorText: "", instructions: "", articleText: "", writingBrief: "" });
  const [consent, setConsent] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [disclosuresOutdated, setDisclosuresOutdated] = useState(false);
  const idempotencyKeyRef = useRef("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const clearCartTriggerRef = useRef<HTMLButtonElement>(null);
  const clearCartCancelRef = useRef<HTMLButtonElement>(null);
  const outdatedDisclosureRef = useRef<HTMLDivElement>(null);
  const catalogFlowHeadingRef = useRef<HTMLHeadingElement>(null);
  const selectedRef = useRef(selected);
  useLayoutEffect(() => { selectedRef.current = selected; }, [selected]);
  const cartVersionsRef = useRef<Record<string, { version: number; generationId: string | null }>>({});
  const cartTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const cartSavingRef = useRef(new Map<string, Promise<void>>());
  const cartDirtyRef = useRef(new Set<string>());
  const cartSaveErrorRef = useRef("");
  const flushCartItemRef = useRef<(listingId: string) => Promise<void>>(async () => undefined);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useLayoutEffect(() => { if (confirmClearCart) clearCartCancelRef.current?.focus(); }, [confirmClearCart]);
  useEffect(() => { if (disclosuresOutdated) outdatedDisclosureRef.current?.focus(); }, [disclosuresOutdated]);
  useEffect(() => { if (step !== "browse") catalogFlowHeadingRef.current?.focus(); }, [step]);
  const selectedListings = Object.values(selected).flatMap((item) => item.listing ? [item.listing] : []);
  const selectedCount = Object.keys(selected).length;
  const unavailableItems = Object.entries(selected).filter(([, item]) => !item.listing || item.unavailable);
  const total = selectedListings.reduce((sum, listing) => sum + listing.retailPriceCents + (selected[listing.id].draft.useWriting ? listing.writingPriceCents ?? 0 : 0), 0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    cartSaveErrorRef.current = "";
    cartVersionsRef.current = {};
    void fetch(`/api/customer/cart?organizationId=${encodeURIComponent(organizationId)}`, {
      credentials: "same-origin", cache: "no-store", signal: controller.signal,
    }).then(async (response) => {
      const result = await response.json() as { items?: Array<{
        listingId: string; listingRevision: number; version: number; generationId: string; draft: ItemDraft; listing: CustomerListing | null;
      }>; error?: string };
      if (!response.ok) throw new Error(result.error ?? "The shared cart could not be loaded.");
      if (!active || controller.signal.aborted) return;
      const restored = Object.fromEntries((result.items ?? []).map((item) => [item.listingId, {
        listing: item.listing ?? undefined,
        listingRevision: item.listingRevision,
        version: item.version,
        generationId: item.generationId,
        draft: item.draft,
        unavailable: !item.listing,
      }]));
      cartVersionsRef.current = Object.fromEntries((result.items ?? []).map((item) => [item.listingId, {
        version: item.version,
        generationId: item.generationId,
      }]));
      setSelected(restored);
      setCartError("");
      setCartLoadedOrganization(organizationId);
      setCartSaveState("saved");
    }).catch((caught) => {
      if (!active || controller.signal.aborted) return;
      const message = caught instanceof Error ? caught.message : "The shared cart could not be loaded.";
      cartSaveErrorRef.current = message;
      setCartError(message);
    });
    return () => { active = false; controller.abort(); };
  }, [organizationId, setCartError, setSelected]);

  function notifyCartUpdated() {
    window.dispatchEvent(new Event("gphkm:customer-cart-updated"));
  }

  function scheduleCartSave(listingId: string) {
    if (cartBusy) return;
    cartDirtyRef.current.add(listingId);
    cartSaveErrorRef.current = "";
    setCartError("");
    const currentTimer = cartTimersRef.current.get(listingId);
    if (currentTimer) clearTimeout(currentTimer);
    setCartSaveState("saving");
    const timer = setTimeout(() => { cartTimersRef.current.delete(listingId); void flushCartItem(listingId); }, 450);
    cartTimersRef.current.set(listingId, timer);
  }

  async function flushCartItem(listingId: string): Promise<void> {
    const pending = cartSavingRef.current.get(listingId);
    if (pending) {
      await pending;
      return;
    }
    if (!cartDirtyRef.current.has(listingId)) return;
    cartDirtyRef.current.delete(listingId);
    const item = selectedRef.current[listingId];
    if (!item?.listing) return;
    const token = cartVersionsRef.current[listingId] ?? { version: item.version, generationId: item.generationId };
    const saving = (async () => {
      const response = await fetch("/api/customer/cart", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          action: "save",
          listingId,
          listingRevision: item.listingRevision,
          version: token.version,
          generationId: token.generationId,
          draft: item.draft,
        }),
      });
      const result = await response.json() as { version?: number; generationId?: string; error?: string };
      if (!response.ok || !Number.isSafeInteger(result.version) || typeof result.generationId !== "string") {
        throw new Error(result.error ?? "Cart details could not be saved.");
      }
      cartVersionsRef.current[listingId] = { version: result.version!, generationId: result.generationId };
      setSelected((current) => current[listingId]
        ? { ...current, [listingId]: { ...current[listingId], version: result.version!, generationId: result.generationId! } }
        : current);
      notifyCartUpdated();
    })();
    cartSavingRef.current.set(listingId, saving);
    try {
      await saving;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Cart details could not be saved.";
      cartSaveErrorRef.current = message;
      cartDirtyRef.current.add(listingId);
      setCartError(message);
    } finally {
      cartSavingRef.current.delete(listingId);
      setCartSaveState(cartDirtyRef.current.size || cartSavingRef.current.size ? "saving" : "saved");
      if (cartDirtyRef.current.has(listingId) && !cartSaveErrorRef.current && !cartTimersRef.current.has(listingId)) {
        const timer = setTimeout(() => { cartTimersRef.current.delete(listingId); void flushCartItem(listingId); }, 0);
        cartTimersRef.current.set(listingId, timer);
      }
    }
  }

  useEffect(() => { flushCartItemRef.current = flushCartItem; });
  useEffect(() => () => {
    for (const timer of cartTimersRef.current.values()) clearTimeout(timer);
    cartTimersRef.current.clear();
    for (const listingId of cartDirtyRef.current) void flushCartItemRef.current(listingId);
  }, [organizationId]);
  useEffect(() => {
    const warnBeforeLeavingUnsavedCart = (event: BeforeUnloadEvent) => {
      if (!cartDirtyRef.current.size && !cartSavingRef.current.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeavingUnsavedCart);
    return () => window.removeEventListener("beforeunload", warnBeforeLeavingUnsavedCart);
  }, []);

  async function flushAllCartItems() {
    const listingIds = Object.keys(selectedRef.current);
    for (const timer of cartTimersRef.current.values()) clearTimeout(timer);
    cartTimersRef.current.clear();
    await Promise.all(listingIds.map(async (listingId) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const pending = cartSavingRef.current.get(listingId);
        if (pending) await pending;
        if (cartDirtyRef.current.has(listingId)) await flushCartItem(listingId);
        if (cartSaveErrorRef.current) break;
        if (!cartSavingRef.current.has(listingId) && !cartDirtyRef.current.has(listingId)) break;
      }
    }));
    if (cartSaveErrorRef.current) throw new Error(cartSaveErrorRef.current);
  }

  async function sendCartAction(body: Record<string, unknown>) {
    const response = await fetch("/api/customer/cart", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, ...body }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "The shared cart could not be updated.");
    return result;
  }

  function change(listingId: string, field: keyof ItemDraft, value: string | boolean) {
    if (cartBusy || !cartLoaded) return;
    idempotencyKeyRef.current = "";
    setSelected((current) => ({ ...current, [listingId]: { ...current[listingId], draft: { ...current[listingId].draft, [field]: value } } }));
    scheduleCartSave(listingId);
  }

  function toggle(listingId: string, checked: boolean) {
    if (cartBusy || !cartLoaded) return;
    idempotencyKeyRef.current = "";
    setError("");
    if (checked && !selected[listingId] && Object.keys(selected).length >= 25) {
      setError("An order can include up to 25 different listings.");
      return;
    }
    if (!checked) { void removeSelected(listingId); return; }
    const listing = listings.find((item) => item.id === listingId);
    if (!listing) return;
    setSelected((current) => ({ ...current, [listingId]: { listing, listingRevision: listing.revision, version: 0, generationId: null, draft: emptyDraft() } }));
    cartVersionsRef.current[listingId] = { version: 0, generationId: null };
    scheduleCartSave(listingId);
  }

  async function removeSelected(listingId: string) {
    if (cartBusy || !cartLoaded) return;
    idempotencyKeyRef.current = "";
    setError("");
    setCartBusy(true);
    const hadUnsavedDraft = cartDirtyRef.current.has(listingId);
    const timer = cartTimersRef.current.get(listingId);
    if (timer) clearTimeout(timer);
    cartTimersRef.current.delete(listingId);
    cartDirtyRef.current.delete(listingId);
    try {
      await cartSavingRef.current.get(listingId)?.catch(() => undefined);
      const token = cartVersionsRef.current[listingId] ?? {
        version: selectedRef.current[listingId]?.version ?? 0,
        generationId: selectedRef.current[listingId]?.generationId ?? null,
      };
      await sendCartAction({ action: "remove", listingId, ...token });
      cartDirtyRef.current.delete(listingId);
      cartVersionsRef.current = Object.fromEntries(Object.entries(cartVersionsRef.current).filter(([id]) => id !== listingId));
      setSelected((current) => {
        const next = { ...current };
        delete next[listingId];
        return next;
      });
      if (Object.keys(selectedRef.current).length <= 1) setStep("browse");
      setCartError("");
      cartSaveErrorRef.current = "";
      notifyCartUpdated();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "This placement could not be removed.";
      if (hadUnsavedDraft || cartDirtyRef.current.has(listingId)) {
        cartDirtyRef.current.add(listingId);
        setCartSaveState("saving");
        const retryTimer = setTimeout(() => {
          cartTimersRef.current.delete(listingId);
          void flushCartItem(listingId);
        }, 450);
        cartTimersRef.current.set(listingId, retryTimer);
      }
      setCartError(message);
      cartSaveErrorRef.current = message;
    } finally {
      setCartBusy(false);
    }
  }

  async function clearCart() {
    if (cartBusy || !cartLoaded) return;
    setCartBusy(true);
    for (const timer of cartTimersRef.current.values()) clearTimeout(timer);
    cartTimersRef.current.clear();
    cartDirtyRef.current.clear();
    try {
      await Promise.all([...cartSavingRef.current.values()].map((pending) => pending.catch(() => undefined)));
      await sendCartAction({ action: "clear" });
      cartVersionsRef.current = {};
      setSelected({});
      setStep("browse");
      setConfirmClearCart(false);
      setCartError("");
      cartSaveErrorRef.current = "";
      notifyCartUpdated();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The shared cart could not be cleared.";
      setCartError(message);
      cartSaveErrorRef.current = message;
      for (const listingId of Object.keys(selectedRef.current)) cartDirtyRef.current.add(listingId);
    } finally {
      setCartBusy(false);
      if (cartSaveErrorRef.current) {
        for (const listingId of Object.keys(selectedRef.current)) scheduleCartSave(listingId);
      }
    }
  }

  function copySharedDetails() {
    if (cartBusy) return;
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
    for (const listing of selectedListings) scheduleCartSave(listing.id);
  }

  function acceptUpdatedListing(listingId: string) {
    const listing = listings.find((item) => item.id === listingId) ?? selectedRef.current[listingId]?.listing;
    if (!listing) return;
    idempotencyKeyRef.current = "";
    setSelected((current) => current[listingId]
      ? { ...current, [listingId]: { ...current[listingId], listing, listingRevision: listing.revision, unavailable: false } }
      : current);
    scheduleCartSave(listingId);
  }

  function continueToReview() {
    setError("");
    if (!selectedListings.length) { setError("Select at least one website to continue."); return; }
    if (Object.values(selected).some((item) => item.unavailable)) {
      setError("Remove unavailable placements before continuing.");
      return;
    }
    if (selectedListings.some((listing) => selected[listing.id].listingRevision !== listing.revision)) {
      setError("A listing’s terms changed. Review the updated details and accept the current terms before continuing.");
      return;
    }
    for (const listing of selectedListings) {
      const item = selected[listing.id].draft;
      if (!item.targetUrl.trim() || !item.anchorText.trim() || (item.useWriting ? !item.writingBrief.trim() : !item.articleText.trim())) {
        setError(`Complete the destination URL, anchor text, and ${item.useWriting ? "writing brief" : "article"} for “${listing.title}”.`);
        return;
      }
    }
    if (selectedListings.some((listing) => selected[listing.id].draft.useWriting && !listing.writingEnabled)) {
      setError("Turn off Writing for listings where it is no longer available.");
      return;
    }
    setConsent(false);
    setPolicyAccepted(false);
    setStep("review");
  }

  async function checkout() {
    if (busy || disclosuresOutdated) return;
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
      await flushAllCartItems();
      const cartVersions = Object.fromEntries(selectedListings.map((listing) => [listing.id, cartVersionsRef.current[listing.id]]));
      if (selectedListings.some((listing) => {
        const token = cartVersions[listing.id];
        return !token || !Number.isSafeInteger(token.version) || token.version < 1 || typeof token.generationId !== "string";
      })) {
        throw new Error("The shared cart is still saving. Try again when it shows Saved.");
      }
      const response = await fetch("/api/customer/orders", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          cartVersions,
          order: {
            idempotencyKey: idempotencyKeyRef.current,
            acceptContentPolicy: policyAccepted,
            disclosureVersions: CHECKOUT_DISCLOSURES,
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
      const result = await response.json().catch(() => null) as { error?: string; code?: string; refreshedListings?: CustomerListing[] } | null;
      if (result?.code === "LISTING_CHANGED" || result?.code === "LISTING_UNAVAILABLE") {
        setConsent(false);
        setPolicyAccepted(false);
        idempotencyKeyRef.current = "";
        if (result.refreshedListings) {
          const refreshed = new Map(result.refreshedListings.map((listing) => [listing.id, listing]));
          setSelected((current) => Object.fromEntries(Object.entries(current).map(([id, item]) => {
            const listing = refreshed.get(id);
            return [id, listing ? {
              ...item,
              listing,
              unavailable: false,
            } : { ...item, unavailable: true }];
          })));
          setStep("details");
        }
        router.refresh();
      }
      if (result?.code === "CHECKOUT_DISCLOSURES_CHANGED") {
        setConsent(false);
        setPolicyAccepted(false);
        setDisclosuresOutdated(true);
      }
      if (!response.ok) throw new Error(result?.error ?? "Order could not be completed.");
      idempotencyKeyRef.current = "";
      notifyCartUpdated();
      router.push(`/customer/orders?organizationId=${encodeURIComponent(organizationId)}&placed=1`);
      router.refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Order could not be completed.";
      setError(message);
      if (/cart has changed/i.test(message)) {
        cartSaveErrorRef.current = message;
        setCartError(message);
      }
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
      {(listing.writingEnabled || item.useWriting) && <label className="catalogWriting"><input type="checkbox" checked={item.useWriting} onChange={(event) => change(listing.id, "useWriting", event.currentTarget.checked)} /> {listing.writingEnabled ? `Add GPHKM Writing · ${dollars(listing.writingPriceCents ?? 0)} · about ${listing.writingTurnaroundDays} days` : "Writing is unavailable for this placement. Turn it off and provide your own article."}</label>}
      {item.useWriting ? <>{listing.writingEnabled && <p className="catalogStageText">Writing has two disclosed stages: first draft {dollars(listing.writingFirstDraftCents ?? 0)} and final draft {dollars(listing.writingFinalDraftCents ?? 0)} after your included revision. Approving the first draft without a revision completes both stages. A delivered stage is earned; only undelivered stages may be credited if a cancellation is approved under the disclosed policy. You review and approve the draft before publication instructions are prepared.</p>}<label>Writing brief <span>Required</span><textarea required maxLength={4000} rows={5} value={item.writingBrief} onChange={(event) => change(listing.id, "writingBrief", event.currentTarget.value)} placeholder="Describe the topic, audience, and points to cover" /></label></>
        : <label>Article <span>Required</span><textarea required maxLength={20000} rows={8} value={item.articleText} onChange={(event) => change(listing.id, "articleText", event.currentTarget.value)} placeholder="Paste the article you want published" /></label>}
      <label>Additional publication instructions <span>Optional</span><textarea maxLength={4000} rows={3} value={item.instructions} onChange={(event) => change(listing.id, "instructions", event.currentTarget.value)} placeholder="Anything else needed for this placement" /></label>
    </div>;
  };

  const stepLabel = step === "browse" ? "Choose placements" : step === "details" ? "Add order details" : "Review order";
  return <>
    {step === "browse" && <>
      {!cartLoaded && <p className="catalogCartLoadError" role={cartError ? "alert" : "status"}>
        {cartError ? <>The shared cart could not be loaded. <button type="button" onClick={() => window.location.reload()}>Reload marketplace</button></> : "Loading shared organization cart…"}
      </p>}
      <CatalogFilters organizationId={organizationId} {...filterProps} />
      <CatalogPagination organizationId={organizationId} {...pageProps} />
      <div className="catalogGrid">
        {listings.map((listing) => {
          const item = selected[listing.id]?.draft;
          const presentMetrics = metricProviders.flatMap(({ provider, label, shortLabel }) => listing.metrics.filter((metric) => metric.provider === provider).map((metric) => ({ metric, label, shortLabel })));
          return <article className="catalogCard" key={listing.id}>
            <div className="catalogCardTop"><label className="catalogSelect"><input type="checkbox" checked={Boolean(item)} disabled={!cartLoaded || cartBusy} onChange={(event) => toggle(listing.id, event.currentTarget.checked)} aria-label={`${item ? "Remove" : "Add"} ${listing.title} ${item ? "from" : "to"} order`} /><span>{item ? "In your order" : "Add to order"}</span></label><div className="catalogPrice"><strong>{dollars(listing.retailPriceCents)}</strong><span>per placement</span></div></div>
            {selected[listing.id] && selected[listing.id].listingRevision !== listing.revision && <div className="catalogCartChanged" role="status"><span>This listing’s price or terms changed since it was added.</span><button type="button" disabled={cartBusy} onClick={() => acceptUpdatedListing(listing.id)}>Review and accept current terms</button></div>}
            <div className="catalogIdentity"><span className="catalogDomainMark" aria-hidden="true">{listing.websiteUrl ? new URL(listing.websiteUrl).hostname.slice(0, 1).toUpperCase() : "G"}</span><div className="catalogIdentityText"><h2>{listing.title}</h2>{listing.websiteUrl ? <a className="catalogSite" href={listing.websiteUrl} target="_blank" rel="noreferrer">{new URL(listing.websiteUrl).hostname}<span aria-hidden="true">↗</span></a> : <span className="catalogHiddenSite">Website address hidden · revealed after a qualifying wallet recharge</span>}</div></div>
            <p className="catalogDescription">{listing.description}</p>
            <ul className="catalogCategories" aria-label="Website categories">{listing.categories.map((category) => <li key={category}>{category}</li>)}</ul>
            <div className="catalogQuickFacts" aria-label="Placement overview"><div><span>Language &amp; region</span><strong>{listing.primaryLanguage} · {listing.countryCode}</strong></div><div><span>Link type</span><strong>{linkTypeLabel[listing.linkType]}</strong></div><div><span>Placement term</span><strong>{validityLabel[listing.linkValidity]}</strong></div><div><span>Turnaround</span><strong>About {listing.turnaroundDays} days</strong></div></div>
            <section className="catalogMetrics" aria-label="Approved domain metrics"><div className="catalogMetricsHeader"><h3>Domain metrics</h3><span>Source-attributed observations</span></div>{presentMetrics.length ? <div className="catalogMetricGrid">{presentMetrics.map(({ metric, label, shortLabel }) => <div className="catalogMetric" key={`${metric.provider}-${metric.metricScope}-${metric.observedOn}-${metric.value}`}><span className="catalogMetricLabel" title={label}>{shortLabel}</span><div className="catalogMetricReading"><strong>{metric.value === null ? "—" : formatMetric(metric.value)}</strong><small>{metricScopeLabel(metric.metricScope)}{formatMetricDate(metric.observedOn) ? ` · ${formatMetricDate(metric.observedOn)}` : ""}</small>{metric.attributionText && <span>{metric.attributionText}</span>}</div></div>)}</div> : <p className="catalogNoMetrics">No approved domain metrics are available for this listing yet.</p>}</section>
            <ListingRequirements listing={listing} />
          </article>;
        })}
      </div>
      {selectedCount > 0 && <section className="catalogOrderTray" aria-label="Selected placements">
        <div className="catalogCartSummary"><strong>{selectedCount} of 25 placements</strong><span>{dollars(total)} estimated</span></div>
        <p>This cart is shared with your organization. Members can view the saved placement details. Checkout consent is requested only when an order is placed.</p>
        <span className="catalogCartSaveState" role="status">{cartError ? `Cart issue: ${cartError}` : cartSaveState === "saving" ? "Saving shared cart…" : "Shared cart saved"}</span>
        <div className="catalogCartActions">
          <button ref={clearCartTriggerRef} type="button" className="catalogClearCart" aria-expanded={confirmClearCart} aria-controls={confirmClearCart ? "catalog-clear-cart-confirmation" : undefined} disabled={cartBusy} onClick={() => setConfirmClearCart(true)}>Clear cart</button>
          <button type="button" disabled={!cartLoaded || cartBusy} onClick={() => { setError(""); setStep("details"); }}>Add order details <span aria-hidden="true">→</span></button>
        </div>
        {confirmClearCart && <div className="catalogClearCartConfirmation" id="catalog-clear-cart-confirmation" role="group" aria-labelledby="catalog-clear-cart-title" aria-describedby="catalog-clear-cart-description">
          <div className="catalogClearCartCopy">
            <strong id="catalog-clear-cart-title">Clear the shared cart?</strong>
            <p id="catalog-clear-cart-description">{selectedCount === 1
              ? "This removes the placement and its saved details for everyone in your organization."
              : `This removes all ${selectedCount} placements and their saved details for everyone in your organization.`}</p>
          </div>
          <div className="catalogClearCartConfirmationActions">
            <button ref={clearCartCancelRef} type="button" className="catalogClearCartCancel" disabled={cartBusy} onClick={() => { setConfirmClearCart(false); clearCartTriggerRef.current?.focus(); }}>Keep cart</button>
            <button type="button" className="catalogClearCartConfirm" disabled={cartBusy} onClick={() => void clearCart()}>{cartBusy ? "Clearing cart…" : selectedCount === 1 ? "Remove placement" : "Remove all placements"}</button>
          </div>
        </div>}
      </section>}
      {error && <p ref={errorRef} role="alert" tabIndex={-1} className="catalogError">{error}</p>}
    </>}

    {step !== "browse" && <section className="catalogFlow" aria-labelledby="catalog-flow-heading">
      <nav className="catalogStepNav" aria-label="Order progress"><span>1 <span>Choose placements</span></span><span aria-current={step === "details" ? "step" : undefined}>2 <span>Add order details</span></span><span aria-current={step === "review" ? "step" : undefined}>3 <span>Review order</span></span></nav>
      <header className="catalogFlowHeader"><div><p className="catalogFlowCount">{selectedListings.length} placement{selectedListings.length === 1 ? "" : "s"} · {dollars(total)} estimated</p><h2 id="catalog-flow-heading" ref={catalogFlowHeadingRef} tabIndex={-1}>{stepLabel}</h2><p>{step === "details" ? "Add one destination and anchor per placement. Your text stays editable until you place the order." : "Check every placement, the estimated total, and the content-sharing terms before placing the order."}</p></div><button type="button" className="catalogSecondaryButton" disabled={busy} onClick={() => setStep("browse")}>Back to marketplace</button></header>
      {disclosuresOutdated && <div ref={outdatedDisclosureRef} role="alert" tabIndex={-1} className="catalogStaleDisclosure">
        <p>Checkout terms changed while this page was open. Copy any article or brief you want to keep before reloading; unsent details are stored only in this page and will be cleared on reload.</p>
        <button type="button" className="catalogSecondaryButton" disabled={busy} onClick={() => window.location.reload()}>Reload current terms</button>
      </div>}
      {step === "details" ? <>
        <details className="catalogCopyDetails"><summary>Copy shared details across selected placements</summary><p>Copy text into each selected item, then review and edit it separately. Article text only copies to placements using customer-supplied content.</p><div className="catalogSharedGrid"><label>Shared destination URL<input type="url" maxLength={2048} value={sharedDetails.targetUrl} onChange={(event) => setSharedDetails((current) => ({ ...current, targetUrl: event.currentTarget.value }))} /></label><label>Shared anchor text<input maxLength={200} value={sharedDetails.anchorText} onChange={(event) => setSharedDetails((current) => ({ ...current, anchorText: event.currentTarget.value }))} /></label><label>Shared publication instructions<textarea maxLength={4000} rows={3} value={sharedDetails.instructions} onChange={(event) => setSharedDetails((current) => ({ ...current, instructions: event.currentTarget.value }))} /></label><label>Shared article<textarea maxLength={20000} rows={3} value={sharedDetails.articleText} onChange={(event) => setSharedDetails((current) => ({ ...current, articleText: event.currentTarget.value }))} /></label><label>Shared writing brief<textarea maxLength={4000} rows={3} value={sharedDetails.writingBrief} onChange={(event) => setSharedDetails((current) => ({ ...current, writingBrief: event.currentTarget.value }))} /></label></div><button type="button" className="catalogCopyButton" onClick={copySharedDetails}>Copy into selected placements</button></details>
        {unavailableItems.map(([listingId]) => <article className="catalogOrderItem" key={listingId}><header><span className="catalogItemNumber">Unavailable placement</span><div><h3>This placement is no longer available</h3><p>Its saved details remain in the shared cart until removed.</p><button type="button" className="catalogItemRemove" disabled={cartBusy} onClick={() => void removeSelected(listingId)}>Remove from cart</button></div></header></article>)}
        <div className="catalogOrderItems">{selectedListings.map((listing, index) => <article className="catalogOrderItem" key={listing.id}><header><span className="catalogItemNumber">Placement {index + 1}</span><div><h3>{listing.title}</h3><p>{listing.categories.join(" · ")}</p><button type="button" className="catalogItemRemove" disabled={cartBusy} onClick={() => void removeSelected(listing.id)}>Remove from cart</button></div><strong>{dollars(listing.retailPriceCents + (selected[listing.id].draft.useWriting ? listing.writingPriceCents ?? 0 : 0))}</strong></header>{selected[listing.id].listingRevision !== listing.revision && <div className="catalogCartChanged" role="status"><span>Price or terms changed. Review the current listing details below, then accept them to continue.</span><button type="button" disabled={cartBusy} onClick={() => acceptUpdatedListing(listing.id)}>Accept current listing terms</button></div>}{selected[listing.id].unavailable ? <p>This listing is no longer available. Remove it to continue.</p> : <>
          <ListingRequirements listing={listing} showOverview />
          {fields(listing)}
        </>}</article>)}</div>
        {error && <p ref={errorRef} role="alert" tabIndex={-1} className="catalogError">{error}</p>}
        <div className="catalogFlowActions"><button type="button" className="catalogPrimaryButton" onClick={continueToReview}>Review order <span aria-hidden="true">→</span></button></div>
      </> : <>
        <div className="catalogReviewList">{selectedListings.map((listing) => { const item = selected[listing.id].draft; return <article key={listing.id}><div><h3>{listing.title}</h3><p>{item.useWriting ? "GPHKM Writing" : "Customer-provided article"} · {validityLabel[listing.linkValidity]} placement</p><p className="catalogReviewDestination">Destination: {item.targetUrl}</p><p>Anchor text: {item.anchorText}</p><details className="catalogReviewContent"><summary>Review {item.useWriting ? "writing brief" : "article"}{item.instructions.trim() ? " and instructions" : ""}</summary><pre>{item.useWriting ? item.writingBrief : item.articleText}</pre>{item.instructions.trim() && <><strong>Additional publication instructions</strong><pre>{item.instructions}</pre></>}</details></div><strong>{dollars(listing.retailPriceCents + (item.useWriting ? listing.writingPriceCents ?? 0 : 0))}</strong></article>; })}</div>
        <p className="catalogReviewNotice">Estimated total <strong>{dollars(total)}</strong>. Final amount is checked against current listing prices and available wallet funds. A completed placement has no replacement or refund if its link later disappears.</p>
        <section className="catalogPolicy" aria-labelledby="content-policy-heading"><h3 id="content-policy-heading">Content policy &amp; sharing</h3><details><summary>Read the content rules</summary><ul>{CUSTOMER_CONTENT_POLICY.map((rule) => <li key={rule}>{rule}</li>)}</ul><p>These rules work alongside each listing&apos;s requirements.</p></details><label className="catalogConsent"><input type="checkbox" disabled={busy || disclosuresOutdated} checked={policyAccepted} onChange={(event) => { setPolicyAccepted(event.currentTarget.checked); idempotencyKeyRef.current = ""; }} /> I have the rights needed to submit this content and links, and I agree to follow the GPHKM content policy.</label><label className="catalogConsent"><input type="checkbox" disabled={busy || disclosuresOutdated} checked={consent} onChange={(event) => { setConsent(event.currentTarget.checked); idempotencyKeyRef.current = ""; }} /> I understand the approved article or brief, destination URL, anchor text, and necessary instructions will be shared with the publication partner to fulfill each placement.</label></section>
        {error && <p ref={errorRef} role="alert" tabIndex={-1} className="catalogError">{error}</p>}
        <div className="catalogFlowActions catalogReviewActions"><button type="button" className="catalogSecondaryButton" disabled={busy} onClick={() => setStep("details")}>Back to details</button><button type="button" className="catalogPrimaryButton" disabled={busy || disclosuresOutdated} onClick={checkout}>{busy ? "Placing order…" : `Place order · ${dollars(total)}`}</button></div>
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
