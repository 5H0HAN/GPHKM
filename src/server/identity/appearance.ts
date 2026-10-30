import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { userAppearancePreference } from "@/db/identity-schema";

export type AppearanceTheme = "DARK" | "LIGHT";

export async function readAppearancePreference(userId: string): Promise<AppearanceTheme> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    const [preference] = await tx.select({ theme: userAppearancePreference.theme })
      .from(userAppearancePreference).where(eq(userAppearancePreference.userId, userId)).limit(1);
    return preference?.theme ?? "DARK";
  });
}

export async function saveAppearancePreference(userId: string, theme: AppearanceTheme): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    await tx.insert(userAppearancePreference).values({ userId, theme })
      .onConflictDoUpdate({
        target: userAppearancePreference.userId,
        set: { theme, updatedAt: new Date() },
      });
  });
}
