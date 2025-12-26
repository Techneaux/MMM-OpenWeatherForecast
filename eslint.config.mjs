import css from "@eslint/css";
import {defineConfig} from "eslint/config";
import globals from "globals";
import js from "@eslint/js";
import markdown from "@eslint/markdown";
import stylistic from "@stylistic/eslint-plugin";

export default defineConfig([
  {
    files: ["**/*.css"],
    plugins: {css},
    language: "css/css",
    extends: ["css/recommended"],
    rules: {
      // Allow non-baseline CSS properties that gracefully degrade (e.g., Firefox scrollbar styling)
      "css/use-baseline": "off"
    }
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.node,
        Log: "readonly",
        Module: "readonly"
      }
    },
    plugins: {
      js,
      "@stylistic": stylistic
    },
    extends: ["js/recommended"],
    rules: {
      // Stylistic rules for consistent formatting
      "@stylistic/array-element-newline": ["error", "consistent"],
      "@stylistic/comma-dangle": ["error", "never"],
      "@stylistic/dot-location": ["error", "property"],
      "@stylistic/function-call-argument-newline": ["error", "consistent"],
      "@stylistic/indent": ["error", 2],
      "@stylistic/object-property-newline": ["error", {allowAllPropertiesOnSameLine: true}],
      "@stylistic/padded-blocks": ["error", "never"],
      "@stylistic/quote-props": ["error", "as-needed"],
      "@stylistic/quotes": ["error", "double"],
      "@stylistic/semi": ["error", "always"],
      "@stylistic/space-before-function-paren": ["error", "always"],
      // Code quality
      "consistent-this": ["error", "self"],
      "one-var": ["error", "never"],
      // Allow underscore-prefixed unused parameters (common convention for intentionally unused args)
      "no-unused-vars": ["error", {argsIgnorePattern: "^_"}]
    }
  },
  {files: ["**/*.md"], plugins: {markdown}, language: "markdown/gfm", extends: ["markdown/recommended"]}
]);
