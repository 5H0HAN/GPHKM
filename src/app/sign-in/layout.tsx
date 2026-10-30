import Link from "next/link";
import styles from "./sign-in.module.css";

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.main}>
      <a className={styles.skipLink} href="#sign-in-panel">Skip to sign-in form</a>
      <Link href="/" className={styles.brand} aria-label="GPHKM home">GPHKM</Link>
      <section className={styles.panel} id="sign-in-panel" tabIndex={-1}>{children}</section>
      <p className={styles.footer}>Your guest placement workspace.</p>
    </main>
  );
}
