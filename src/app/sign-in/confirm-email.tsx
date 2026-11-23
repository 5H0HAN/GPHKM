import styles from "./confirm-email.module.css";

export default function ConfirmEmail({ token, callbackURL, staff = false }: {
  token: string | null;
  callbackURL: string | null;
  staff?: boolean;
}) {
  const validToken = token !== null && token.length <= 2048 && /^[A-Za-z0-9_.-]{20,2048}$/.test(token);
  return (
    <div>
      <h1>Verify your email</h1>
      <p className={styles.description}>
        {validToken
          ? `Confirm this email address to ${staff ? "continue setting up your GPHKM staff account" : "finish setting up your GPHKM account"}.`
          : "This verification link is invalid or incomplete. Request a fresh verification email and try again."}
      </p>
      {validToken && <form className={styles.form} action="/api/auth/verify-email" method="get">
        <input type="hidden" name="token" value={token} />
        {callbackURL && <input type="hidden" name="callbackURL" value={callbackURL} />}
        <button className={styles.primary} type="submit">Verify email</button>
      </form>}
    </div>
  );
}
