import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * ESLint configuration for backend service
 * 
 * Key rules:
 * - @typescript-eslint/no-explicit-any: warn (for existing code)
 * - Stricter "error" level for new code in specific directories
 * 
 * Run: npm run lint
 */
export default tseslint.config(
  { ignores: ["dist", "node_modules", "**/*.js", "drizzle/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // Type safety: error on any usage (enforce explicit types)
      // Use inline disable with justification if any is truly unavoidable
      "@typescript-eslint/no-explicit-any": ["error"],
      
      // Unused vars: allow underscore-prefixed
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      
      // Allow empty catch blocks with comment
      "no-empty": ["warn", { allowEmptyCatch: true }],
      
      // Prefer unknown over any in catch blocks
      "@typescript-eslint/no-unsafe-assignment": "off", // Too noisy with existing code
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      
      // Allow require for config files
      "@typescript-eslint/no-require-imports": "off",
      
      // Consistent type imports
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  // Stricter rules for NEW code - enforce error on any in new directories
  // These directories are considered "clean" and should stay type-safe
  {
    files: [
      "src/shared/types/**/*.ts",
      "src/config/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": ["error"],
    },
  },
  // Test files can be more lenient
  {
    files: ["tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  // Boundary rules: agent-brain domain must remain pure (no runtime/infrastructure deps)
  {
    files: ["src/domains/agent-brain/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@/domains/platform/*",
            "@/domains/platform/**",
            "@/domains/agent-brain/application/**",
            "@/domains/**/adapters/**",
            "@/domains/**/infrastructure/**",
            "@/shared/**",
            "@/db/**",
            "@/config/**",
            "@/app/**",
            "@/interfaces/**",
            "node:*",
            "fs",
            "path",
            "os",
            "crypto",
            "child_process",
            "worker_threads",
            "http",
            "https",
            "net",
            "tls",
            "zlib",
            "url",
            "stream",
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[init.type='NewExpression']",
          message: "Do not export singleton instances from the domain; use factories/injection.",
        },
        {
          selector: "ExportDefaultDeclaration > NewExpression",
          message: "Do not export singleton instances from the domain; use factories/injection.",
        },
      ],
    },
  },
  // Boundary rules: agent-brain application must not import platform or runtime-only modules
  {
    files: ["src/domains/agent-brain/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@/domains/platform/*",
            "@/domains/platform/**",
            "node:*",
            "fs",
            "path",
            "os",
            "crypto",
            "child_process",
            "worker_threads",
            "http",
            "https",
            "net",
            "tls",
            "zlib",
            "url",
            "stream",
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/platform/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            "@/domains/agent-brain/**",
            "!@/domains/agent-brain/ports",
            "!@/domains/agent-brain/ports/**",
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/platform/sandbox/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@/db/**",
            "@/shared/**",
            "node:*",
            "fs",
            "path",
            "os",
            "crypto",
            "child_process",
            "worker_threads",
            "http",
            "https",
            "net",
            "tls",
            "zlib",
            "url",
            "stream",
          ],
        },
      ],
    },
  },
  // Boundary rules: subscriptions domain should keep runtime adapters in infrastructure
  {
    files: ["src/domains/platform/subscriptions/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@/db/**",
            "stripe",
            "node:*",
            "fs",
            "path",
            "os",
            "crypto",
            "child_process",
            "worker_threads",
            "http",
            "https",
            "net",
            "tls",
            "zlib",
            "url",
            "stream",
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/platform/subscriptions/infrastructure/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            "@/domains/agent-brain/**",
            "!@/domains/agent-brain/ports",
            "!@/domains/agent-brain/ports/**",
          ],
        },
      ],
    },
  },
  // Boundary rules: interface layer should not reach into adapters/db/repositories directly
  {
    files: ["src/interfaces/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            "@/domains/platform/**",
            "@/domains/evaluation/**",
            "@/domains/**/adapters/**",
            "@/domains/**/store/**",
            "@/domains/**/persistence/**",
            "@/domains/**/repositories/**",
            "@/db/**",
          ],
        },
      ],
    },
  },
  // Boundary rules: shared middleware should not depend on platform domain modules
  {
    files: ["src/shared/middleware/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["@/domains/**"],
        },
      ],
    },
  },
  {
    files: ["src/interfaces/http/controllers/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@/domains/platform/**",
            "@/domains/evaluation/**",
            "@/domains/**/adapters/**",
            "@/domains/**/infrastructure/**",
            "@/domains/**/repositories/**",
            "@/db/**",
          ],
        },
      ],
    },
  },
  // Temporary migration carve-out for legacy SecurityOps controllers still using direct DB access.
  // Keep this list explicit so new controllers remain bound by the stricter boundary rule above.
  {
    files: [
      "src/interfaces/http/controllers/ai-agent/routes/sessions.router.ts",
      "src/interfaces/http/controllers/assets.router.ts",
      "src/interfaces/http/controllers/automations.router.ts",
      "src/interfaces/http/controllers/chat.router.ts",
      "src/interfaces/http/controllers/connected-sites.router.ts",
      "src/interfaces/http/controllers/dashboard/*.ts",
      "src/interfaces/http/controllers/dashboard.router.ts",
      "src/interfaces/http/controllers/admin/threat-watch.admin.router.ts",
      "src/interfaces/http/controllers/exposure.router.ts",
      "src/interfaces/http/controllers/findings.router.ts",
      "src/interfaces/http/controllers/github-webhook.router.ts",
      "src/interfaces/http/controllers/integrations.router.ts",
      "src/interfaces/http/controllers/organization.router.ts",
      "src/interfaces/http/controllers/public.ts",
      "src/interfaces/http/controllers/runner-agent.router.ts",
      "src/interfaces/http/controllers/runner-agent.websocket.ts",
      "src/interfaces/http/controllers/runners.router.ts",
      "src/interfaces/http/controllers/runs.router.ts",
      "src/interfaces/http/controllers/scopes.router.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
