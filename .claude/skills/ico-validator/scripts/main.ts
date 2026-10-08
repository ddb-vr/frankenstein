import { readFileSync } from "node:fs";
import { validateInput } from "./ico.ts";

try {
  const input: unknown = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(`${JSON.stringify(validateInput(input))}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}
