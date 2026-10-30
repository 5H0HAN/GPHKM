import styles from "./page.module.css";
import Link from "next/link";

export default function Home() {
  return (
    <main className={styles.main}>
      <div className={styles.mark} aria-hidden="true">G</div>
      <p className={styles.eyebrow}>Guest placement workspace</p>
      <h1>Guest placements, managed in one place.</h1>
      <p className={styles.intro}>
        Explore reviewed publishing opportunities, place orders for your team,
        and follow each placement through publication updates.
      </p>
      <Link className={styles.signIn} href="/sign-in">
        Continue to customer sign-in <span aria-hidden="true">→</span>
      </Link>
      <p className={styles.accessNote}>
        A verified account is required before you can browse the marketplace.
      </p>
    </main>
  );
}
