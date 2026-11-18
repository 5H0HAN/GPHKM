import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { customerLegalAcceptance } from "@/db/legal-schema";
import { appendAuditEvent, type DbTransaction } from "@/server/audit/append";
import { assertExplicitLegalAcceptance, currentLegalDocuments, LegalAcceptanceRequiredError, matchesCurrentLegalAcceptance, type LegalAcceptanceInput, type LegalDocuments } from "@/modules/legal/policy";

export async function acceptedLegalVersions(tx: DbTransaction, userId: string, documents: LegalDocuments) {
  const [row] = await tx.select({ termsVersion: customerLegalAcceptance.termsVersion, privacyVersion: customerLegalAcceptance.privacyVersion,
    termsUrl: customerLegalAcceptance.termsUrl, privacyUrl: customerLegalAcceptance.privacyUrl })
    .from(customerLegalAcceptance).where(and(eq(customerLegalAcceptance.userId, userId),
      eq(customerLegalAcceptance.termsVersion, documents.termsVersion), eq(customerLegalAcceptance.privacyVersion, documents.privacyVersion))).limit(1);
  return row;
}

export async function requireCurrentLegalAcceptance(tx: DbTransaction, userId: string): Promise<void> {
  const documents = currentLegalDocuments(process.env);
  if (!matchesCurrentLegalAcceptance(await acceptedLegalVersions(tx, userId, documents), documents)) throw new LegalAcceptanceRequiredError();
}

export async function recordLegalAcceptance(tx: DbTransaction, userId: string, input: LegalAcceptanceInput): Promise<void> {
  const documents = currentLegalDocuments(process.env);
  assertExplicitLegalAcceptance(input, documents);
  const prior = await acceptedLegalVersions(tx, userId, documents);
  if (prior) {
    if (!matchesCurrentLegalAcceptance(prior, documents)) throw new LegalAcceptanceRequiredError();
    return;
  }
  const [created] = await tx.insert(customerLegalAcceptance).values({ id: randomUUID(), userId, actorUserId: userId, ...documents })
    .onConflictDoNothing({ target: [customerLegalAcceptance.userId, customerLegalAcceptance.termsVersion, customerLegalAcceptance.privacyVersion] })
    .returning({ id: customerLegalAcceptance.id });
  if (!created) {
    if (!matchesCurrentLegalAcceptance(await acceptedLegalVersions(tx, userId, documents), documents)) throw new LegalAcceptanceRequiredError();
    return;
  }
  await appendAuditEvent(tx, { actorUserId: userId, action: "CUSTOMER_LEGAL_ACCEPTANCE_RECORDED", targetType: "CUSTOMER_LEGAL_ACCEPTANCE", targetId: created.id,
    metadata: { result: "ACCEPTED" } });
}
