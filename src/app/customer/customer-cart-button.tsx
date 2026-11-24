"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { chooseOrganizationId } from "@/modules/identity/organizations";
import type { CustomerListing } from "@/modules/catalog/domain";
import type { CustomerCartDraft } from "@/modules/orders/cart";
import styles from "./customer.module.css";

type CartItem = {
  listingId: string;
  listingRevision: number;
  generationId: string;
  version: number;
  draft: CustomerCartDraft;
  listing: CustomerListing | null;
};

type OrganizationOption = { id: string; name: string };
type CartUi = {
  organizationId: string;
  open: boolean;
  count: number;
  items: CartItem[];
  accessAllowed: boolean;
  loading: boolean;
  error: string;
  confirmClear: boolean;
  confirmRemoveListingId: string | null;
  mutationBusy: boolean;
};

function emptyCartUi(organizationId: string): CartUi {
  return { organizationId, open: false, count: 0, items: [], accessAllowed: true, loading: false, error: "", confirmClear: false, confirmRemoveListingId: null, mutationBusy: false };
}

async function cartRequest(organizationId: string, body?: Record<string, unknown>) {
  const options: RequestInit = {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
  };
  if (body) {
    options.headers = { "content-type": "application/json" };
    options.body = JSON.stringify({ organizationId, ...body });
  }
  const path = body ? "/api/customer/cart" : `/api/customer/cart?organizationId=${encodeURIComponent(organizationId)}`;
  return fetch(path, options);
}

export function CustomerCartButton({ organizations }: { organizations: OrganizationOption[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const organizationId = chooseOrganizationId(organizations, searchParams.get("organizationId")) ?? "";
  const organizationIdRef = useRef(organizationId);
  useLayoutEffect(() => { organizationIdRef.current = organizationId; }, [organizationId]);
  const organization = organizations.find((item) => item.id === organizationId);
  const isMarketplace = pathname === "/customer/catalog";
  const [ui, setUi] = useState<CartUi>(() => emptyCartUi(organizationId));
  const cartButtonRef = useRef<HTMLButtonElement>(null);
  const cartCloseRef = useRef<HTMLButtonElement>(null);
  const clearTriggerRef = useRef<HTMLButtonElement>(null);
  const clearConfirmRef = useRef<HTMLButtonElement>(null);
  const removeCancelRef = useRef<HTMLButtonElement>(null);
  const removeTriggerRef = useRef(new Map<string, HTMLButtonElement>());
  const { open, count, items, accessAllowed, loading, error, confirmClear, confirmRemoveListingId, mutationBusy } =
    ui.organizationId === organizationId ? ui : emptyCartUi(organizationId);
  const updateUi = useCallback((changes: Partial<Omit<CartUi, "organizationId">>) => {
    setUi((current) => ({
      ...(current.organizationId === organizationId ? current : emptyCartUi(organizationId)),
      ...changes,
      organizationId,
    }));
  }, [organizationId]);

  const refreshCount = useCallback(async () => {
    if (!organizationId) return;
    try {
      const response = await fetch(`/api/customer/cart?organizationId=${encodeURIComponent(organizationId)}&summary=1`, {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) return;
      const result = await response.json() as { count: number };
      if (organizationIdRef.current !== organizationId) return;
      updateUi({ count: result.count });
    } catch { /* The count refresh must not interrupt navigation. */ }
  }, [organizationId, updateUi]);

  const refreshItems = useCallback(async (): Promise<CartItem[] | null> => {
    if (!organizationId) return null;
    updateUi({ loading: true, error: "" });
    try {
      const response = await fetch(`/api/customer/cart?organizationId=${encodeURIComponent(organizationId)}`, {
        credentials: "same-origin", cache: "no-store",
      });
      const result = await response.json() as { items?: CartItem[]; accessAllowed?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "The shared cart could not be loaded.");
      if (organizationIdRef.current !== organizationId) return null;
      const nextItems = result.items ?? [];
      updateUi({ items: nextItems, accessAllowed: result.accessAllowed !== false, count: nextItems.length });
      return nextItems;
    } catch (caught) {
      if (organizationIdRef.current !== organizationId) return null;
      updateUi({ error: caught instanceof Error ? caught.message : "The shared cart could not be loaded." });
      return null;
    } finally {
      if (organizationIdRef.current === organizationId) updateUi({ loading: false });
    }
  }, [organizationId, updateUi]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshCount(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshCount]);
  useEffect(() => {
    const update = () => { void refreshCount(); if (open) void refreshItems(); };
    const onVisibility = () => { if (document.visibilityState === "visible") update(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        updateUi({ open: false, confirmClear: false, confirmRemoveListingId: null });
        cartButtonRef.current?.focus();
      }
    };
    window.addEventListener("focus", update);
    window.addEventListener("gphkm:customer-cart-updated", update);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("gphkm:customer-cart-updated", update);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, refreshCount, refreshItems, updateUi]);
  useEffect(() => { if (confirmClear) clearConfirmRef.current?.focus(); }, [confirmClear]);
  useLayoutEffect(() => { if (confirmRemoveListingId) removeCancelRef.current?.focus(); }, [confirmRemoveListingId]);

  function cancelRemoveItem() {
    const listingId = confirmRemoveListingId;
    updateUi({ confirmRemoveListingId: null });
    requestAnimationFrame(() => {
      const trigger = listingId ? removeTriggerRef.current.get(listingId) : undefined;
      (trigger ?? cartCloseRef.current)?.focus();
    });
  }

  async function removeItem(listingId: string) {
    if (mutationBusy || confirmRemoveListingId !== listingId) return;
    const itemIndex = items.findIndex((candidate) => candidate.listingId === listingId);
    const item = items[itemIndex];
    if (!item) return;
    const preferredFocusListingId = items[itemIndex + 1]?.listingId ?? items[itemIndex - 1]?.listingId ?? null;
    updateUi({ mutationBusy: true, error: "" });
    try {
      const response = await cartRequest(organizationId, {
        action: "remove", listingId, generationId: item.generationId, version: item.version,
      });
      const result = await response.json() as { error?: string };
      if (organizationIdRef.current !== organizationId) return;
      if (response.status === 409) {
        const currentItems = await refreshItems();
        if (organizationIdRef.current !== organizationId) return;
        updateUi({ confirmRemoveListingId: null, error: result.error ?? "The shared cart changed. Review the current placements and try again." });
        const focusListingId = preferredFocusListingId && currentItems?.some((candidate) => candidate.listingId === preferredFocusListingId)
          ? preferredFocusListingId : currentItems?.[0]?.listingId ?? null;
        requestAnimationFrame(() => {
          const trigger = focusListingId ? removeTriggerRef.current.get(focusListingId) : undefined;
          (trigger ?? cartCloseRef.current)?.focus();
        });
        return;
      }
      if (!response.ok) throw new Error(result.error ?? "This placement could not be removed.");
      updateUi({ confirmRemoveListingId: null });
      const currentItems = await refreshItems();
      if (organizationIdRef.current !== organizationId) return;
      const focusListingId = preferredFocusListingId && currentItems?.some((candidate) => candidate.listingId === preferredFocusListingId)
        ? preferredFocusListingId : currentItems?.[0]?.listingId ?? null;
      requestAnimationFrame(() => {
        const trigger = focusListingId ? removeTriggerRef.current.get(focusListingId) : undefined;
        (trigger ?? cartCloseRef.current)?.focus();
      });
      window.dispatchEvent(new Event("gphkm:customer-cart-updated"));
    } catch (caught) {
      if (organizationIdRef.current === organizationId) updateUi({ error: caught instanceof Error ? caught.message : "This placement could not be removed." });
    } finally {
      if (organizationIdRef.current === organizationId) updateUi({ mutationBusy: false });
    }
  }

  async function clearCart() {
    if (mutationBusy) return;
    updateUi({ mutationBusy: true, error: "" });
    try {
      const response = await cartRequest(organizationId, { action: "clear" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The shared cart could not be cleared.");
      if (organizationIdRef.current !== organizationId) return;
      updateUi({ items: [], count: 0, confirmClear: false, confirmRemoveListingId: null });
      requestAnimationFrame(() => cartButtonRef.current?.focus());
      window.dispatchEvent(new Event("gphkm:customer-cart-updated"));
    } catch (caught) {
      if (organizationIdRef.current === organizationId) updateUi({ error: caught instanceof Error ? caught.message : "The shared cart could not be cleared." });
    } finally {
      if (organizationIdRef.current === organizationId) updateUi({ mutationBusy: false });
    }
  }

  return <div className={styles.cartDock}>
    <button
      ref={cartButtonRef}
      className={styles.cartButton}
      type="button"
      aria-expanded={open}
      aria-controls="customer-shared-cart"
      aria-label={`Shared organization cart, ${count} placement${count === 1 ? "" : "s"}`}
      onClick={() => {
        const nextOpen = !open;
        updateUi({ open: nextOpen, ...(nextOpen ? {} : { confirmClear: false, confirmRemoveListingId: null }) });
        if (nextOpen) void refreshItems();
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.1 10.1a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 1.9-1.4L21 8H7" /><circle cx="10" cy="20" r="1.2" /><circle cx="18" cy="20" r="1.2" /></svg>
      <span className={styles.cartButtonText}>Cart</span>
      <span className={styles.cartCount} aria-live="polite">{count}</span>
    </button>
    {open && <section className={styles.cartPopover} id="customer-shared-cart" aria-label="Shared organization cart">
      <header className={styles.cartPopoverHeader}>
        <div><h2>Shared cart</h2><p>{organization?.name ?? "Current organization"}</p></div>
        <button ref={cartCloseRef} type="button" className={styles.cartCloseButton} aria-label="Close shared cart" onClick={() => { updateUi({ open: false, confirmClear: false, confirmRemoveListingId: null }); cartButtonRef.current?.focus(); }}>×</button>
      </header>
      <p className={styles.cartSharedNotice}>Saved for everyone in this organization. Members can read the placement details and content. Items stay here until removed or submitted in an order.</p>
      {loading ? <p className={styles.cartPopoverStatus}>Loading saved placements…</p>
        : error ? <p role="alert" className={styles.cartPopoverError}>{error}</p>
          : items.length === 0 ? <p className={styles.cartPopoverStatus}>Your shared cart is empty.</p>
            : !accessAllowed ? <p className={styles.cartPopoverStatus}>Marketplace access is unavailable. Your saved cart remains here.</p>
              : <ul className={styles.cartPopoverItems}>
                {items.map((item) => {
                  const title = item.listing?.title ?? "Unavailable placement";
                  return <li key={item.listingId}>
                    <div className={styles.cartItemDetails}>
                      <strong>{title}</strong>
                      {item.listing && <span>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(item.listing.retailPriceCents / 100)}</span>}
                    </div>
                    {confirmRemoveListingId === item.listingId ? <div className={styles.cartItemRemoveConfirm} role="group" aria-labelledby="customer-cart-remove-title" aria-describedby="customer-cart-remove-description">
                      <div className={styles.cartItemRemoveConfirmCopy}>
                        <strong id="customer-cart-remove-title">Remove {title}?</strong>
                        <p id="customer-cart-remove-description">This also removes its saved details for everyone in your organization.</p>
                      </div>
                      <div className={styles.cartItemRemoveConfirmActions}>
                        <button ref={removeCancelRef} type="button" disabled={mutationBusy} onClick={cancelRemoveItem}>Keep placement</button>
                        <button type="button" className={styles.cartItemRemoveConfirmButton} disabled={mutationBusy} onClick={() => void removeItem(item.listingId)}>Remove placement</button>
                      </div>
                    </div> : <button
                      ref={(element) => {
                        if (element) removeTriggerRef.current.set(item.listingId, element);
                        else removeTriggerRef.current.delete(item.listingId);
                      }}
                      type="button"
                      className={styles.cartItemRemoveButton}
                      disabled={mutationBusy}
                      aria-label={`Remove ${title} from shared cart`}
                      title="Remove placement"
                      onClick={() => updateUi({ confirmClear: false, confirmRemoveListingId: item.listingId, error: "" })}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                    </button>}
                  </li>;
                })}
              </ul>}
      {isMarketplace ? <p className={styles.cartPopoverStatus}>Edit placement details in the marketplace tray.</p> : items.length > 0 && <>
        <button ref={clearTriggerRef} className={styles.cartClearButton} type="button" aria-expanded={confirmClear} aria-controls={confirmClear ? "customer-cart-clear-confirmation" : undefined} disabled={mutationBusy} onClick={() => updateUi({ confirmClear: true, confirmRemoveListingId: null })}>Clear cart</button>
        {confirmClear && <div className={styles.cartClearConfirm} id="customer-cart-clear-confirmation" role="group" aria-label="Confirm clearing the shared cart">
          <p>Remove every saved placement and its entered details?</p>
          <button ref={clearConfirmRef} type="button" disabled={loading || mutationBusy} onClick={() => void clearCart()}>Confirm clear</button>
          <button type="button" disabled={mutationBusy} onClick={() => { updateUi({ confirmClear: false }); clearTriggerRef.current?.focus(); }}>Keep cart</button>
        </div>}
      </>}
      <Link className={styles.cartMarketplaceLink} href={`/customer/catalog?organizationId=${encodeURIComponent(organizationId)}`} onClick={() => updateUi({ open: false, confirmClear: false })}>Open marketplace</Link>
    </section>}
  </div>;
}
