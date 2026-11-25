import shared from "@kiro-ai-bit/eslint-config";

// Layer direction (LLD §3): WebAPI -> Application -> Core -> Infrastructure.
// Higher layers may import lower; lower layers may not import higher.
export default [
  ...shared,
  {
    files: ["Infrastructure/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@core/*",
                "@application/*",
                "@webapi/*",
                "fastify",
                "fastify/*",
              ],
              message: "Infrastructure is the lowest layer — no upward imports",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["Core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@application/*", "@webapi/*", "fastify", "fastify/*"],
              message:
                "Core may import Infrastructure only — not Application/WebAPI/transport",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["Application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@webapi/*", "fastify", "fastify/*"],
              message: "Application may not import WebAPI or transport",
            },
          ],
        },
      ],
    },
  },
];
