import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function preparePrivateFileUpload() {
  const key = randomUUID();
  await db.execute(sql`select public.gphkm_register_private_file_upload(${key})`);
  return key;
}

export async function linkPrivateFileUpload(tx: Tx, key: string) {
  await tx.execute(sql`select public.gphkm_link_private_file_upload(${key})`);
}

export async function queuePrivateFileDelete(tx: Tx, key: string) {
  await tx.execute(sql`select public.gphkm_queue_private_file_delete(${key})`);
}

export async function queuePrivateFileDeleteOutsideTransaction(key: string) {
  await db.execute(sql`select public.gphkm_queue_private_file_delete(${key})`);
}
