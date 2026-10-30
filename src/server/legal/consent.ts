import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerLegalAcceptance } from "@/db/legal-schema";
import { appendAuditEvent, type DbTransaction } from "@/server/audit/append";
import { getAuthForSurface } from "@/server/auth";
import { resolveAuthSurface } from "@/server/auth/surfaces";
import { assertExplicitLegalAcceptance, currentLegalDocuments, LegalAcceptanceRequiredError, matchesCurrentLegalAcceptance, type LegalAcceptanceInput, type LegalDocuments } from "@/modules/legal/policy";

async function acceptedVersions(tx: DbTransaction, userId: string, documents: LegalDocuments) {
  const [row] = await tx.select({ termsVersion: customerLegalAcceptance.termsVersion, privacyVersion: customerLegalAcceptance.privacyVersion,
    termsUrl: customerLegalAcceptance.termsUrl, privacyUrl: customerLegalAcceptance.privacyUrl })
    .from(customerLegalAcceptance).where(and(eq(customerLegalAcceptance.userId, userId),
      eq(customerLegalAcceptance.termsVersion, documents.termsVersion), eq(customerLegalAcceptance.privacyVersion, documents.privacyVersion))).limit(1);
  return row;
}

export async function requireCurrentLegalAcceptance(tx: DbTransaction, userId: string): Promise<void> {
  const documents = currentLegalDocuments(process.env);
  if (!matchesCurrentLegalAcceptance(await acceptedVersions(tx, userId, documents), documents)) throw new LegalAcceptanceRequiredError();
}

export async function recordLegalAcceptance(tx: DbTransaction, userId: string, input: LegalAcceptanceInput): Promise<void> {
  const documents = currentLegalDocuments(process.env);
  assertExplicitLegalAcceptance(input, documents);
  const prior = await acceptedVersions(tx, userId, documents);
  if (prior) {
    if (!matchesCurrentLegalAcceptance(prior, documents)) throw new LegalAcceptanceRequiredError(); // Changed documents require a new version ID.
    return;
  }
  const [created] = await tx.insert(customerLegalAcceptance).values({ id: randomUUID(), userId, actorUserId: userId, ...documents })
    .onConflictDoNothing({ target: [customerLegalAcceptance.userId, customerLegalAcceptance.termsVersion, customerLegalAcceptance.privacyVersion] })
    .returning({ id: customerLegalAcceptance.id });
  if (!created) {
    if (!matchesCurrentLegalAcceptance(await acceptedVersions(tx, userId, documents), documents)) throw new LegalAcceptanceRequiredError();
    return;
  }
  await appendAuditEvent(tx, { actorUserId: userId, action: "CUSTOMER_LEGAL_ACCEPTANCE_RECORDED", targetType: "CUSTOMER_LEGAL_ACCEPTANCE", targetId: created.id,
    metadata: { result: "ACCEPTED" } });
}

async function legalActor(headers: Headers) {
  if (resolveAuthSurface(headers, process.env) !== "customer") throw new Error("Unauthorized");
  const authenticated = await getAuthForSurface("customer").api.getSession({ headers });
  if (!authenticated?.user.emailVerified) throw new Error("Unauthorized");
  return authenticated.user.id;
}

export async function getCustomerLegalState(headers: Headers) {
  const userId = await legalActor(headers);
  const documents = currentLegalDocuments(process.env);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    const accepted = matchesCurrentLegalAcceptance(await acceptedVersions(tx, userId, documents), documents);
    return { documents, accepted };
  });
}

export async function listCustomerLegalAcceptanceHistory(headers: Headers) {
  const userId = await legalActor(headers);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return tx.select({
      termsVersion: customerLegalAcceptance.termsVersion,
      privacyVersion: customerLegalAcceptance.privacyVersion,
      acceptedAt: customerLegalAcceptance.acceptedAt,
    }).from(customerLegalAcceptance)
      .where(eq(customerLegalAcceptance.userId, userId))
      .orderBy(desc(customerLegalAcceptance.acceptedAt), desc(customerLegalAcceptance.id));
  });
}

export async function acceptCustomerLegalDocuments(headers: Headers, input: LegalAcceptanceInput) {
  const userId = await legalActor(headers);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    await recordLegalAcceptance(tx, userId, input);
  });
}
