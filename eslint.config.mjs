import { defineConfig, globalIgnores } from "eslint/config";
import eslintReact from "@eslint-react/eslint-plugin";
import next from "@next/eslint-plugin-next";
import reactA11y from "eslint-plugin-react-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  eslintReact.configs["recommended-typescript"],
  reactHooks.configs.flat.recommended,
  {
    plugins: { "react-a11y": reactA11y },
    rules: {
      "react-a11y/alt-text": "warn",
      "react-a11y/aria-props": "warn",
      "react-a11y/aria-unsupported-elements": "warn",
      "react-a11y/role-has-required-aria-props": "warn",
      "react-a11y/role-supports-aria-props": "warn",
    },
  },
  next.configs["core-web-vitals"],
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
