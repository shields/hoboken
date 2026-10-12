// Copyright © 2026 Michael Shields
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    // .claude holds Claude Code's workspace, including worktree copies of this
    // repo under .claude/worktrees/ that would otherwise be linted as source.
    ignores: ["node_modules/", ".claude/", ".build/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  unicorn.configs.unopinionated,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: "error",
      "unicorn/numeric-separators-style": [
        "error",
        { number: { minimumDigits: 7 } },
      ],
    },
  },
  {
    files: ["eslint.config.ts"],
    rules: {
      "unicorn/no-top-level-side-effects": "off",
    },
  },
  {
    files: ["src/convert.ts", "integration/wled-simulator.ts"],
    rules: {
      // WLED text payloads use integer-prefix parsing, including trailing text.
      "unicorn/prefer-number-coercion": "off",
    },
  },
  {
    files: [
      "src/accessories.ts",
      "test/accessories.test.ts",
      "test/bridge.test.ts",
    ],
    rules: {
      // Node tick ordering determines which characteristic writes coalesce.
      "unicorn/prefer-queue-microtask": "off",
    },
  },
  {
    files: ["src/log.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["integration/*-roundtrip.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },
  prettier,
);
