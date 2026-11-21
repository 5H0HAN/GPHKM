import type { Ref } from "react";
import { usesStagingTesterNotices, type LegalDocuments } from "@/modules/legal/policy";
import styles from "./legal-consent.module.css";

export function LegalConsentCheckbox({ documents, disabled = false, inputRef, form }: { documents: LegalDocuments; disabled?: boolean; inputRef?: Ref<HTMLInputElement>; form?: string }) {
  const testing = usesStagingTesterNotices(documents);
  return <label className={styles.checkbox}>
    <input ref={inputRef} form={form} type="checkbox" name="accepted" required disabled={disabled} />
    <span>I have read and accept the <a href={documents.termsUrl} target="_blank" rel="noopener noreferrer">{testing ? "Staging tester Terms" : "Terms of Service"}</a> and <a href={documents.privacyUrl} target="_blank" rel="noopener noreferrer">{testing ? "Staging tester Privacy notice" : "Privacy Policy"}</a>.</span>
  </label>;
}
