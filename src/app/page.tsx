import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <div className={styles.mark} aria-hidden="true">G</div>
      <p className={styles.eyebrow}>Guest placement workspace</p>
      <h1>Publication work, kept in order.</h1>
      <p className={styles.intro}>
        GPHKM brings curated placements, clear order progress, and account
        controls into one workspace.
      </p>
      <div className={styles.status} role="status">
        <span className={styles.statusDot} />
        <span>Workspace foundation is ready</span>
      </div>
      <p className={styles.note}>
        Sign-in and organization setup are the next implementation slice.
      </p>
    </main>
  );
}
