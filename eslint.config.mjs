import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

// Shared flat config for the Node-side workspaces: apps/api, apps/worker, and
// every package under packages/. ESLint walks up from each package's cwd to
// find this file, so those packages need only a `lint` script -- no per-package
// config.
//
// apps/dashboard is deliberately excluded: it has its own eslint.config.js with
// browser globals and the React plugins, which wins because ESLint finds it
// first when linting from that directory.
export default defineConfig([
  globalIgnores([
    "**/dist/**",
    "**/node_modules/**",
    "**/.turbo/**",
    "apps/dashboard/**",
    "packages/db/generated/**"
  ]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node
    },
    rules: {
      // Surface accidental leftovers without failing the build on intentional
      // ones; the codebase uses `_`-prefixed names for deliberate discards.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  }
]);
