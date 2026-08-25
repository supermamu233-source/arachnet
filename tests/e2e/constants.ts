// No imports here on purpose — this file is imported both by Playwright's
// own test-runner context (tests/e2e/helpers.ts) and by the standalone
// tsx-run fixture script (tests/e2e/seed-e2e-user.ts). Keeping it dependency
// free avoids pulling the ESM-only generated Prisma client into Playwright's
// runner, which fails there (see seed-e2e-user.ts's comment).
export const E2E_ORG_SLUG = "e2e-test-org";
export const E2E_OWNER_EMAIL = "e2e-owner@arachnet.local";
export const E2E_OWNER_PASSWORD = "e2e-test-password-123456";
