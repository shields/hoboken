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
);
