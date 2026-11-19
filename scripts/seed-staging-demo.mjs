import { randomUUID } from "node:crypto";
import { stagingTransaction } from "./staging-setup.mjs";

// These fictional publications use reserved domains. No operational contact or credentials are seeded.
const publications = [
  { title: "Demo Garden Journal", category: "Gardening and Lawn Care", domain: "garden-journal.example", price: 8500, days: 7, publicUrl: true, supplierSourced: false },
  { title: "Demo Software Review", category: "Software Development", domain: "software-review.example", price: 14000, days: 10, publicUrl: false, supplierSourced: true },
  { title: "Demo City Guide", category: "Local & City Guides", domain: "city-guide.example", price: 11000, days: 5, publicUrl: false, supplierSourced: false },
];

async function seed(db) {
  // An immutable marker written with the inventory keeps reruns from resetting staff edits.
  const marker = "staging.demo_catalog.v1";
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [marker]);
  if ((await db.query("SELECT 1 FROM audit_event WHERE id = $1 AND action = 'STAGING_DEMO_CATALOG_CREATED'", [marker])).rowCount) {
    return "Staging demo catalog was already seeded.";
  }

  const actorId = randomUUID();
  await db.query("INSERT INTO auth_user (id, name, email) VALUES ($1, 'Staging catalog fixture', 'catalog-seed@staging.invalid')", [actorId]);
  const supplierId = randomUUID();
  await db.query(`INSERT INTO supplier (id, name, notes, created_by_user_id)
    VALUES ($1, 'Demo Editorial Group', 'Synthetic staging supplier.', $2)`, [supplierId, actorId]);

  for (const publication of publications) {
    const id = randomUUID();
    const terms = {
      title: publication.title, description: `Fictional staging publication covering ${publication.category.toLowerCase()}.`,
      countryCode: "US", primaryLanguage: "English", categories: [publication.category],
      retailPriceCents: publication.price, turnaroundDays: publication.days, websiteUrl: `https://${publication.domain}/`,
      linkType: "SPONSORED", linkValidity: "ONE_YEAR", sponsoredContentMarking: true,
      allowsSportsAndGaming: false, allowsPharmacy: false, allowsCrypto: false, allowsForeignLanguage: false,
      writingEnabled: false, writingPriceCents: null, writingFirstDraftCents: null, writingFinalDraftCents: null,
      writingTurnaroundDays: null, buyerRequirements: null,
    };
    await db.query(`INSERT INTO marketplace_listing
      (id, title, description, country_code, primary_language, categories, retail_price_cents, turnaround_days,
       link_type, link_validity, sponsored_content_marking, allows_sports_and_gaming, allows_pharmacy, allows_crypto, allows_foreign_language)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,false,false,false,false)`,
    [id, terms.title, terms.description, terms.countryCode, terms.primaryLanguage, terms.categories,
      terms.retailPriceCents, terms.turnaroundDays, terms.linkType, terms.linkValidity]);
    const sourceSupplier = publication.supplierSourced ? supplierId : null;
    await db.query(`INSERT INTO marketplace_listing_sourcing
      (listing_id, commercial_source, supplier_id, fulfillment_supplier_id, url_visible_without_recharge, created_by_user_id)
      VALUES ($1,$2,$3,$3,$4,$5)`, [id, sourceSupplier ? "SUPPLIER_SOURCED" : "PLATFORM_OWNED", sourceSupplier, publication.publicUrl, actorId]);
    await db.query("INSERT INTO marketplace_listing_url (listing_id, website_url) VALUES ($1,$2)", [id, terms.websiteUrl]);
    await db.query("UPDATE marketplace_listing SET status = 'LIVE' WHERE id = $1", [id]);
    await db.query(`INSERT INTO marketplace_listing_revision (listing_id, revision, terms, actor_user_id, reason)
      VALUES ($1,1,$2,$3,'Synthetic staging catalog fixture')`, [id, terms, actorId]);
  }
  await db.query(`INSERT INTO audit_event (id, actor_user_id, action, target_type, target_id)
    VALUES ($1,$2,'STAGING_DEMO_CATALOG_CREATED','staging_fixture',$1)`, [marker, actorId]);
  return `Seeded ${publications.length} synthetic staging listings and one private supplier.`;
}

try {
  console.log(await stagingTransaction(seed));
} catch {
  console.error("Staging catalog seed failed. Check staging flags, database name, migrations, and migration-role access.");
  process.exitCode = 1;
}
