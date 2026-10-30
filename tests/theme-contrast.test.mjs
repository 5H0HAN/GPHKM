import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function luminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function readPalette(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)]
    .map(([, key, value]) => [key, value]));
}

test("dark and light palettes meet WCAG AA contrast for text and primary buttons", async () => {
  const css = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const themes = {
    dark: css.match(/:root,\s*\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1],
    light: css.match(/\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1],
  };

  for (const [name, block] of Object.entries(themes)) {
    assert.ok(block, `${name} palette is defined`);
    const palette = readPalette(block);
    for (const foreground of ["text-primary", "text-secondary", "text-muted", "text-tertiary", "disabled", "accent-text"]) {
      for (const background of ["canvas", "surface-1", "surface-2"]) {
        assert.ok(contrast(palette[foreground], palette[background]) >= 4.5,
          `${name} ${foreground} on ${background} must meet 4.5:1`);
      }
    }
    for (const status of ["success", "warning", "error", "info"]) {
      assert.ok(contrast(palette[status], palette[`${status}-soft`]) >= 4.5,
        `${name} ${status} text on its status surface must meet 4.5:1`);
    }
    assert.ok(contrast(palette["accent-contrast"], palette["primary-button"]) >= 4.5,
      `${name} primary button text must meet 4.5:1`);
  }
});
