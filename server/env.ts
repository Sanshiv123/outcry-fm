import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");

const schema = z.object({
  MOCK_MODE: z.enum(["true", "false"]).default("true").transform(v => v === "true"),
  MAX_ORDER_USD: z.coerce.number().positive().max(5).default(5),
  MAX_DAILY_USD: z.coerce.number().positive().max(20).default(20),
  MAX_STATION_USD: z.coerce.number().positive().max(50).default(50),
  TM_API_KEY_PATH: z.string().default(".secrets"),
  TM_TOKENS: z
    .string()
    .default(
      "SOL,CBBTC@base",
    )
    .transform((list) =>
      list
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  PORT: z.coerce.number().int().positive().default(4747),
  DATA_FILE: z.string().default("data/customers.json"),
});

type Env = z.infer<typeof schema>;

function parseEnv(): Env {
  // A blank line in .env means "use the default", not "set to empty".
  const raw = Object.fromEntries(
    Object.keys(schema.shape).map((name) => [name, process.env[name] || undefined]),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`invalid environment:\n  ${problems.join("\n  ")}`);
  }
  if (!process.env.DATA_FILE) parsed.data.DATA_FILE = `data/${parsed.data.MOCK_MODE ? "mock" : "live"}/customers.json`;
  return parsed.data;
}

export const env: Readonly<Env> = Object.freeze(parseEnv());
