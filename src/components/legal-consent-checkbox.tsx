import type { LegalDocuments } from "@/modules/legal/policy";
import styles from "./legal-consent.module.css";

export function LegalConsentCheckbox({ documents, disabled = false }: { documents: LegalDocuments; disabled?: boolean }) {
  return <label className={styles.checkbox}>
    <input type="checkbox" name="accepted" required disabled={disabled} />
    <span>I have read and accept the <a href={documents.termsUrl} target="_blank" rel="noopener noreferrer">Terms ({documents.termsVersion})</a> and <a href={documents.privacyUrl} target="_blank" rel="noopener noreferrer">Privacy Policy ({documents.privacyVersion})</a>.</span>
  </label>;
}
