"use client";

import { QRCodeSVG } from "qrcode.react";
import styles from "./totp.module.css";

export function TotpSecretPanel({ uri }: { uri: string }) {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const grouped = secret.match(/.{1,4}/g)?.join(" ") ?? "";
  return (
    <div className={styles.setup}>
      <p>Scan this code with your authenticator app. If you can’t scan it, enter the setup key or use the setup link.</p>
      <QRCodeSVG value={uri} size={192} level="M" marginSize={2} role="img" aria-label="Authenticator setup QR code" className={styles.qr} />
      <label>Manual setup key
        <input type="text" value={grouped} readOnly spellCheck={false} autoComplete="off" />
      </label>
      <label>Authenticator setup link
        <textarea value={uri} readOnly spellCheck={false} rows={3} />
      </label>
    </div>
  );
}

export function BackupCodesPanel({ codes, showHeading = true }: { codes: string[]; showHeading?: boolean }) {
  return (
    <div className={styles.backup}>
      {showHeading && <h2>Save your backup codes</h2>}
      <p>These codes are shown once. Store them somewhere private. Each code can be used once.</p>
      <ul aria-label="Backup codes" className={styles.codes}>
        {codes.map((code) => <li key={code}><code>{code}</code></li>)}
      </ul>
    </div>
  );
}
