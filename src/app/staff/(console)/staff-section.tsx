import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireStaffAccess } from "@/server/auth/staff";
import type { StaffPermission } from "@/server/identity/policy";
import styles from "./staff.module.css";

export async function StaffSection({ eyebrow, title, description, permission, emptyTitle, emptyDescription }: {
  eyebrow: string;
  title: string;
  description: string;
  permission: StaffPermission;
  emptyTitle: string;
  emptyDescription: string;
}) {
  try { await requireStaffAccess(await headers(), permission); }
  catch { redirect("/staff"); }
  return (
    <>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>{eyebrow}</p><h1>{title}</h1><p className={styles.lede}>{description}</p></div>
      </header>
      <section className={styles.notice}>
        <span className={styles.noticeDot} />
        <div><strong>{emptyTitle}</strong><p>{emptyDescription}</p></div>
      </section>
    </>
  );
}
