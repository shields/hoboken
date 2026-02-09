import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// eslint-disable-next-line @typescript-eslint/no-deprecated -- no defineConfig() in ESLint 9
export default tseslint.config(
  {
    ignores: ["node_modules/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
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
