// Entry point: reads `{ "text": string }` from stdin, writes
// `{ "words": number, "chars": number }` to stdout.

export interface TextStats {
  chars: number;
  words: number;
}

const WHITESPACE = /\s+/;

export const textStats = (input: unknown): TextStats => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("text" in input) ||
    typeof input.text !== "string"
  ) {
    throw new Error("text must be a string");
  }
  const { text } = input;
  return {
    chars: text.length,
    words: text.split(WHITESPACE).filter((word) => word !== "").length,
  };
};

const main = async (): Promise<void> => {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  try {
    process.stdout.write(`${JSON.stringify(textStats(JSON.parse(raw)))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        error: (error as Error).message,
      })}\n`
    );
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
