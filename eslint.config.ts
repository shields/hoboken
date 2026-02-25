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
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

// eslint-disable-next-line @typescript-eslint/no-deprecated -- no defineConfig() in ESLint 9
export default tseslint.config(
  {
    ignores: ["node_modules/"],
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
    files: ["integration/wled-roundtrip.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },
);
