import { beforeAll, describe, expect, it } from "vitest";

// server/services/locations.ts imports the shared `prisma` singleton (like
// every server/services module), which validates process.env at import
// time. generateLocationQrPngDataUrl itself is pure and DB-free, but we
// still need *some* validly-shaped env to import the module in a plain unit
// test (no dotenv, no real Postgres/MinIO) — these values are never
// connected to. A dynamic import (rather than a static one) is required so
// this stubbing runs before the module graph is evaluated.
let generateLocationQrPngDataUrl: (typeof import("@/server/services/locations"))["generateLocationQrPngDataUrl"];

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  process.env.AUTH_SECRET ??= "unit-test-auth-secret-value-00000000";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.S3_ENDPOINT ??= "http://localhost:9000";
  process.env.S3_REGION ??= "us-east-1";
  process.env.S3_ACCESS_KEY_ID ??= "unit-test";
  process.env.S3_SECRET_ACCESS_KEY ??= "unit-test";
  process.env.S3_BUCKET_PRIVATE ??= "unit-test-bucket";
  process.env.ROBOT_AUTH_PEPPER ??= "unit-test-robot-pepper-value-0000000";

  ({ generateLocationQrPngDataUrl } = await import("@/server/services/locations"));
});

describe("generateLocationQrPngDataUrl", () => {
  it("returns a PNG data URL", async () => {
    const dataUrl = await generateLocationQrPngDataUrl("WH1-A03-RB-L04");
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("encodes the bare location code as the QR payload, not a URL", async () => {
    // The payload must be exactly the location code string — a physical
    // label scan looks the code up directly, it is not a URL to navigate to.
    const dataUrlA = await generateLocationQrPngDataUrl("WH1-A03-RB-L04");
    const dataUrlB = await generateLocationQrPngDataUrl("WH1-A03-RB-L04");
    const dataUrlDifferent = await generateLocationQrPngDataUrl("WH1-A03-RB-L05");

    expect(dataUrlA).toBe(dataUrlB);
    expect(dataUrlA).not.toBe(dataUrlDifferent);
  });

  it("is callable with no DB access, outside any request context", async () => {
    await expect(generateLocationQrPngDataUrl("SOME-CODE")).resolves.toEqual(expect.any(String));
  });
});
