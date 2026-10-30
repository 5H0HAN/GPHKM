"use client";

import { useLayoutEffect, useState } from "react";
import { saveAppearanceTheme } from "@/app/theme-actions";

function applyTheme(theme: "DARK" | "LIGHT") {
  const value = theme.toLowerCase();
  document.documentElement.dataset.theme = value;
  document.querySelectorAll<HTMLElement>("[data-theme]").forEach((element) => { element.dataset.theme = value; });
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme === "DARK" ? "#17202a" : "#f1eadb";
}

export function ThemeToggle({ initialTheme = "DARK" }: { initialTheme?: "DARK" | "LIGHT" }) {
  const [theme, setTheme] = useState(initialTheme);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  async function toggle() {
    if (saving) return;
    const previous = theme;
    const next = theme === "LIGHT" ? "DARK" : "LIGHT";
    setSaving(true);
    setMessage("");
    setTheme(next);
    try {
      if (!await saveAppearanceTheme(next)) throw new Error("Preference was not saved");
    } catch {
      setTheme(previous);
      applyTheme(previous);
      setMessage("Appearance could not be saved. Sign in again and retry.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button className="themeToggle" type="button" onClick={toggle} disabled={saving} aria-label={`Switch to ${theme === "LIGHT" ? "dark" : "light"} theme`} aria-pressed={theme === "LIGHT"} title={`Current theme: ${theme === "LIGHT" ? "Light" : "Dark"}`}>
      <span aria-hidden="true">{theme === "LIGHT" ? "☼" : "◐"}</span><span>Appearance: {theme === "LIGHT" ? "Light" : "Dark"}</span>
    </button>
    <span className="themeToggleStatus" role="status" aria-live="polite">{message}</span>
  </>;
}
