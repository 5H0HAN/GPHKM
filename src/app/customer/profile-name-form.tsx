"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/auth/client";
import styles from "./customer.module.css";

export function ProfileNameForm({ initialName }: { initialName: string }) {
  const [name, setName] = useState(initialName);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim().replace(/\s+/g, " ");
    if (cleanName.length < 1 || cleanName.length > 100 || /[\u0000-\u001f\u007f]/.test(cleanName)) {
      setMessage("Use a name between 1 and 100 safe characters.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const result = await authClient.updateUser({ name: cleanName });
      if (result.error) { setMessage("Your name could not be saved. Try again."); return; }
      setName(cleanName);
      setMessage("Name saved.");
    } catch { setMessage("Your name could not be saved. Check your connection and try again."); }
    finally { setSaving(false); }
  }

  return (
    <form onSubmit={save} className={styles.profileNameForm}>
      <label htmlFor="profile-name">Display name</label>
      <div className={styles.profileNameFields}>
        <input
          id="profile-name"
          name="name"
          autoComplete="name"
          maxLength={100}
          required
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
          <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save name"}</button>
      </div>
      <p className={styles.profileNameMessage} role="status" aria-live="polite">{message}</p>
    </form>
  );
}
