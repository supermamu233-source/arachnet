import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url(),
  DIRECT_URL: z.url().optional(),

  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  APP_URL: z.url(),

  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_PRIVATE: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("true")
    .transform((value) => value === "true"),

  ROBOT_AUTH_PEPPER: z.string().min(32, "ROBOT_AUTH_PEPPER must be at least 32 characters"),
  MAX_UPLOAD_BYTES: z
    .string()
    .default("2097152")
    .transform((value) => Number.parseInt(value, 10)),

  EMAIL_PROVIDER: z.string().default("console"),
  EMAIL_FROM: z.email().default("no-reply@arachnet.local"),

  SENTRY_DSN: z.string().optional(),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Validates and returns process.env on first access. Fails fast at startup
 * (per the "no unvalidated configuration" requirement) rather than surfacing
 * a confusing error deep in a request handler.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
