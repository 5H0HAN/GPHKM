import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerLegalAcceptance } from "@/db/legal-schema";
import { acceptedLegalVersions, recordLegalAcceptance } from "@/server/legal/acceptance";
import { getAuthForSurface } from "@/server/auth";
import { resolveAuthSurface } from "@/server/auth/surfaces";
import { currentLegalDocuments, matchesCurrentLegalAcceptance, type LegalAcceptanceInput } from "@/modules/legal/policy";

export { recordLegalAcceptance, requireCurrentLegalAcceptance } from "@/server/legal/acceptance";

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
    const accepted = matchesCurrentLegalAcceptance(await acceptedLegalVersions(tx, userId, documents), documents);
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
    await tx.execute(sql`select public.gphkm_assert_active_customer()`);
    await recordLegalAcceptance(tx, userId, input);
  });
}
