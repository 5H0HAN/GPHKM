"use client";

import { useState } from "react";
import type { CommercialSource } from "@/modules/catalog/domain";
import styles from "./catalog.module.css";

type SupplierOption = { id: string; name: string };

export function ListingSourceFields({
  suppliers,
  initialCommercialSource,
  initialSupplierId,
}: {
  suppliers: SupplierOption[];
  initialCommercialSource: CommercialSource;
  initialSupplierId: string;
}) {
  const [commercialSource, setCommercialSource] = useState(initialCommercialSource);
  const [supplierId, setSupplierId] = useState(
    initialCommercialSource === "SUPPLIER_SOURCED" ? initialSupplierId : "",
  );

  return <>
    <label>Commercial source<select
      name="commercialSource"
      value={commercialSource}
      onChange={(event) => {
        const nextSource = event.currentTarget.value as CommercialSource;
        setCommercialSource(nextSource);
        if (nextSource === "PLATFORM_OWNED") setSupplierId("");
      }}
    >
      <option value="PLATFORM_OWNED">Platform owned</option>
      <option value="SUPPLIER_SOURCED">Supplier sourced</option>
    </select></label>
    <label>Source supplier<select
      name="supplierId"
      value={supplierId}
      onChange={(event) => setSupplierId(event.currentTarget.value)}
      disabled={commercialSource === "PLATFORM_OWNED"}
      required={commercialSource === "SUPPLIER_SOURCED"}
      aria-describedby="source-supplier-description"
    >
      <option value="">Choose a supplier</option>
      {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
    </select><small id="source-supplier-description" className={styles.fieldHint}>
      {commercialSource === "PLATFORM_OWNED"
        ? "No source supplier is assigned to a platform-owned listing."
        : "Choose the supplier providing this listing."}
    </small></label>
  </>;
}
