import Link from "next/link";
import { authSurfaceOrigins } from "@/server/auth/surfaces";
import styles from "./page.module.css";

const steps = [
  { title: "Find the right placement", detail: "Compare publication requirements, language, region, and approved metrics." },
  { title: "Order for your organization", detail: "Select up to 25 websites and provide the details each placement needs." },
  { title: "Track the work", detail: "Follow clear milestones, recent updates, and the next update date." },
];

const milestones = [
  "Order received",
  "Content review",
  "Preparing your placement",
  "Publication in progress",
  "Link verification",
  "Complete or resolved",
];

export default function Home() {
  const customerSignIn = new URL("/sign-in", authSurfaceOrigins(process.env).customer).toString();

  return (
    <main className={styles.site}>
      <a className={styles.skipLink} href="#main-content">Skip to main content</a>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="GPHKM home">
          <span className={styles.brandMark} aria-hidden="true">G</span>
          <span>GPHKM</span>
        </Link>
        <a className={styles.headerAnchor} href="#how-it-works">How it works</a>
      </header>

      <section className={styles.hero} id="main-content" aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <p className={styles.kicker}><span aria-hidden="true" /> Guest placement workspace</p>
          <h1 id="hero-title">A clearer path from placement order to publication.</h1>
          <p className={styles.intro}>
            Find the right website, place an order for your organization, and keep every update in one focused workspace.
          </p>
          <a className={styles.primaryAction} href={customerSignIn}>Sign in or create a customer account</a>
          <p className={styles.accessNote}>A verified customer account is required to browse the marketplace.</p>
        </div>

        <aside className={styles.progressPanel} aria-labelledby="progress-title">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.panelEyebrow}>Your order journey</p>
              <h2 id="progress-title">Know what happens next</h2>
            </div>
            <span className={styles.timelineMark} aria-hidden="true"><span /></span>
          </div>
          <ol className={styles.milestones}>
            {milestones.map((milestone, index) => (
              <li className={styles.milestone} key={milestone}>
                <span className={`${styles.milestoneDot} ${index === 0 ? styles.currentDot : ""}`} aria-hidden="true" />
                <span>{milestone}</span>
                {index === 0 && <span className={styles.currentLabel}>First update</span>}
              </li>
            ))}
          </ol>
          <p className={styles.panelFootnote}>You’ll see customer-safe progress updates and a next-update date in your workspace.</p>
        </aside>
      </section>

      <section className={styles.workflow} id="how-it-works" aria-labelledby="workflow-title">
        <div className={styles.sectionHeading}>
          <div><p className={styles.sectionKicker}>How it works</p><h2 id="workflow-title">One clear process for every placement</h2></div>
          <p>Keep your team’s orders, organization balance, and publication updates together.</p>
        </div>
        <ol className={styles.steps}>
          {steps.map((step, index) => (
            <li className={styles.step} key={step.title}>
              <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.organization} aria-labelledby="organization-title">
        <div>
          <p className={styles.sectionKicker}>Made for teams</p>
          <h2 id="organization-title">A shared workspace with clear access</h2>
          <p>Share a workspace with your team. Keep order history and wallet balance together, with access shaped by each person’s role.</p>
        </div>
        <p className={styles.note}>Listing URLs stay hidden until your organization has marketplace access, unless a listing is specifically made public.</p>
      </section>

      <footer className={styles.footer}>
        <span>GPHKM</span>
        <span>Guest placement workspace</span>
      </footer>
    </main>
  );
}
