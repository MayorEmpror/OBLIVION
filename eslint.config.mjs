import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * ESLint 9 flat config.
 *
 * ESLint 9 dropped the legacy `.eslintrc.json` format. `eslint-config-next` 16
 * ships its presets as native flat-config arrays, so they are spread directly —
 * no `FlatCompat` bridge required.
 */

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default eslintConfig;
