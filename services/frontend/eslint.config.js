
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config({ ignores: ["dist"] }, {
  extends: [js.configs.recommended, ...tseslint.configs.recommended],
  files: ["**/*.{ts,tsx}"],
  languageOptions: {
    ecmaVersion: 2020,
    globals: globals.browser,
  },
  plugins: {
    "react-hooks": reactHooks,
    "react-refresh": reactRefresh,
  },
  rules: {
    ...reactHooks.configs.recommended.rules,
    "react-refresh/only-export-components": [
      "warn",
      {
        allowConstantExport: true,
        allowExportNames: [
          "APP_NAV_ITEMS",
          "getSidebarPlanBadgeLabel",
          "getCheckoutPriceId",
          "normalizePromoCode",
        ],
      },
    ],
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": ["warn"],
    "@typescript-eslint/no-empty-object-type": "off",
    "no-empty": "warn",
    "no-case-declarations": "warn",
    // Allow require imports for Tailwind config
    "@typescript-eslint/no-require-imports": "off",
    // Prevent drifting back to legacy client imports
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@/services/api/client",
            message: "Use @/shared/api as the single API entry point.",
          },
        ],
      },
    ],
  },
}, {
  files: ["src/**/*.{ts,tsx}"],
  ignores: [
    "src/shared/services/toastService.ts",
    "src/shared/services/toastService.test.ts",
    "src/shared/ui/AppToaster.tsx",
  ],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "ImportDeclaration[source.value='sonner']",
        message: "Use @shared/services/toastService for notifications, or @shared/ui/AppToaster for the app-level renderer.",
      },
      {
        selector: "ExportNamedDeclaration[source.value='sonner']",
        message: "Do not re-export Sonner directly; keep Sonner behind the shared toast boundary.",
      },
      {
        selector: "ExportAllDeclaration[source.value='sonner']",
        message: "Do not re-export Sonner directly; keep Sonner behind the shared toast boundary.",
      },
    ],
  },
}, {
  files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
  },
}, {
  files: ["src/shared/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "@modules/*",
              "@/modules/*",
              "../modules/*",
              "../../modules/*",
              "@/routes/*",
              "../routes/*",
              "../../routes/*",
            ],
            message: "Shared layer cannot import modules or routes.",
          },
        ],
      },
    ],
  },
}, {
  files: [
    "src/shared/contexts/**/*.{ts,tsx}",
    "src/modules/**/*Context.tsx",
    "src/modules/**/*Provider.tsx",
  ],
  rules: {
    "react-refresh/only-export-components": "off",
  },
}, {
  files: ["src/shared/hooks/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "@modules/*",
              "@/modules/*",
              "../modules/*",
              "../../modules/*",
              "@/routes/*",
              "../routes/*",
              "../../routes/*",
            ],
            message: "Shared hooks cannot import modules or routes.",
          },
        ],
      },
    ],
  },
}, {
  files: ["src/modules/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "@/routes/*",
              "../routes/*",
              "../../routes/*",
            ],
            message: "Modules should not import routes; keep routes as thin wrappers.",
          },
        ],
      },
    ],
  },
}, {
  files: ["src/routes/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["../routes/*", "@/routes/*"],
            message: "Routes should not import other routes directly.",
          },
          {
            group: ["../modules/*/*", "@/modules/*/*", "@modules/*/*"],
            message: "Routes should import module barrels, not deep paths.",
          },
        ],
      },
    ],
  },
});
