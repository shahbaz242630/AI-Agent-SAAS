import type { z } from "zod";

/**
 * Validate process configuration at boot and fail fast on misconfiguration.
 * Every app defines its own zod env schema; this is the single loader so
 * validation behaviour (error shape, source override for tests) is consistent.
 *
 * @param schema  zod schema describing the app's environment
 * @param source  env source — defaults to process.env; tests pass plain objects
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data as z.infer<S>;
}
