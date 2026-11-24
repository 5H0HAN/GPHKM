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
  mutationBusy: boolean;
};

function emptyCartUi(organizationId: string): CartUi {
  return { organizationId, open: false, count: 0, items: [], accessAllowed: true, loading: false, error: "", confirmClear: false, mutationBusy: false };
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
  const clearTriggerRef = useRef<HTMLButtonElement>(null);
  const clearConfirmRef = useRef<HTMLButtonElement>(null);
  const { open, count, items, accessAllowed, loading, error, confirmClear, mutationBusy } =
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

  const refreshItems = useCallback(async () => {
    if (!organizationId) return;
    updateUi({ loading: true, error: "" });
    try {
      const response = await fetch(`/api/customer/cart?organizationId=${encodeURIComponent(organizationId)}`, {
        credentials: "same-origin", cache: "no-store",
      });
      const result = await response.json() as { items?: CartItem[]; accessAllowed?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "The shared cart could not be loaded.");
      if (organizationIdRef.current !== organizationId) return;
      updateUi({ items: result.items ?? [], accessAllowed: result.accessAllowed !== false, count: result.items?.length ?? 0 });
    } catch (caught) {
      if (organizationIdRef.current !== organizationId) return;
      updateUi({ error: caught instanceof Error ? caught.message : "The shared cart could not be loaded." });
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
      if (event.key === "Escape") {
        updateUi({ open: false, confirmClear: false });
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

  async function removeItem(listingId: string) {
    if (mutationBusy) return;
    updateUi({ mutationBusy: true, error: "" });
    try {
      const response = await cartRequest(organizationId, { action: "remove", listingId });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "This placement could not be removed.");
      if (organizationIdRef.current !== organizationId) return;
      await refreshItems();
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
      updateUi({ items: [], count: 0, confirmClear: false });
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
        updateUi({ open: nextOpen, ...(nextOpen ? {} : { confirmClear: false }) });
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
        <button type="button" className={styles.cartCloseButton} aria-label="Close shared cart" onClick={() => { updateUi({ open: false, confirmClear: false }); cartButtonRef.current?.focus(); }}>×</button>
      </header>
      <p className={styles.cartSharedNotice}>Saved for everyone in this organization. Members can read the placement details and content. Items stay here until removed or submitted in an order.</p>
      {loading ? <p className={styles.cartPopoverStatus}>Loading saved placements…</p>
        : error ? <p role="alert" className={styles.cartPopoverError}>{error}</p>
          : items.length === 0 ? <p className={styles.cartPopoverStatus}>Your shared cart is empty.</p>
            : !accessAllowed ? <p className={styles.cartPopoverStatus}>Marketplace access is unavailable. Your saved cart remains here.</p>
              : <ul className={styles.cartPopoverItems}>
                {items.map((item) => <li key={item.listingId}>
                  <div><strong>{item.listing?.title ?? "Unavailable placement"}</strong>
                    {item.listing && <span>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(item.listing.retailPriceCents / 100)}</span>}
                  </div>
                  {!isMarketplace && <button type="button" disabled={mutationBusy} aria-label={`Remove ${item.listing?.title ?? "unavailable placement"} from shared cart`} onClick={() => void removeItem(item.listingId)}>Remove</button>}
                </li>)}
              </ul>}
      {isMarketplace ? <p className={styles.cartPopoverStatus}>Manage placements in the marketplace tray.</p> : items.length > 0 && <>
        <button ref={clearTriggerRef} className={styles.cartClearButton} type="button" aria-expanded={confirmClear} aria-controls={confirmClear ? "customer-cart-clear-confirmation" : undefined} disabled={mutationBusy} onClick={() => updateUi({ confirmClear: true })}>Clear cart</button>
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
