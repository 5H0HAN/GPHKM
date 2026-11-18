import type { Ref } from "react";
import type { LegalDocuments } from "@/modules/legal/policy";
import styles from "./legal-consent.module.css";

export function LegalConsentCheckbox({ documents, disabled = false, inputRef, form }: { documents: LegalDocuments; disabled?: boolean; inputRef?: Ref<HTMLInputElement>; form?: string }) {
  return <label className={styles.checkbox}>
    <input ref={inputRef} form={form} type="checkbox" name="accepted" required disabled={disabled} />
    <span>I have read and accept the <a href={documents.termsUrl} target="_blank" rel="noopener noreferrer">Terms ({documents.termsVersion})</a> and <a href={documents.privacyUrl} target="_blank" rel="noopener noreferrer">Privacy Policy ({documents.privacyVersion})</a>.</span>
  </label>;
}
