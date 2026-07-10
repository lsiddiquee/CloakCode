// Flat ESLint config (ESLint 10) for the CloakCode monorepo. Lints the TypeScript
// packages that were previously un-linted (the pre-commit hook + `pnpm -r lint`
// now actually check code). Type-aware rules are intentionally deferred — the
// non-type-checked `recommended` set catches real issues cheaply.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      ".local/**",
      "**/*.config.{js,mjs,cjs,ts}",
      "research/**",
      "mockups/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-side packages: the extension host, the protocol contract, the agent.
    files: ["packages/{extension,protocol,agent}/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The phone-first PWA runs in the browser (React + Vite).
    files: ["packages/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Allow intentional `_`-prefixed unused bindings (callback params/vars we
    // deliberately ignore).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
