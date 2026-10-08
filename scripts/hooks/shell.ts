// Minimal shell tokenizer for hook heuristics (Bash and simple PowerShell).
// Splits a command line into simple commands on unquoted `;`, `&`, `&&`, `|`,
// `||`, parentheses and newlines, removes quotes, separates redirect targets
// and flags command/process substitution. Not a full shell parser: callers
// treat it as a second layer behind permissions and file guards.

export interface Word {
  /** Source text including quotes and backslashes (PowerShell paths). */
  raw: string;
  /** Bash value: quotes removed, backslash escapes applied. */
  value: string;
}

export interface SimpleCommand {
  redirects: Word[];
  words: Word[];
}

export interface ParsedCommand {
  commands: SimpleCommand[];
  /** `$(…)`, backticks or `<(…)` / `>(…)` appear outside single quotes. */
  substitution: boolean;
}

const BLANK = /[ \t\r]/;
const DIGITS = /^\d+$/;
const FD_DUPLICATE = /^&(\d+|-)/;
const COMMAND_SEPARATORS = new Set([";", "\n", "(", ")", "|", "&"]);
const REDIRECT_CHARS = new Set([">", "<", "&"]);
// Characters a backslash escapes inside double quotes (bash semantics).
const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$", "`", "\n"]);

interface WordState {
  redirect: boolean;
  start: number;
  value: string;
}

export const parseCommand = (source: string): ParsedCommand => {
  const commands: SimpleCommand[] = [];
  let substitution = false;
  let words: Word[] = [];
  let redirects: Word[] = [];
  // `start === -1`: between words. `redirect`: the next word is a target.
  const word: WordState = { redirect: false, start: -1, value: "" };

  const beginWord = (index: number): void => {
    if (word.start === -1) {
      word.start = index;
    }
  };

  const endWord = (index: number): void => {
    if (word.start !== -1) {
      const done = { raw: source.slice(word.start, index), value: word.value };
      (word.redirect ? redirects : words).push(done);
      word.redirect = false;
    }
    word.start = -1;
    word.value = "";
  };

  const endCommand = (index: number): void => {
    endWord(index);
    if (words.length > 0 || redirects.length > 0) {
      commands.push({ redirects, words });
    }
    words = [];
    redirects = [];
    word.redirect = false;
  };

  const doubleQuoted = (from: number): number => {
    let index = from;
    while (index < source.length && source[index] !== '"') {
      const char = source[index] ?? "";
      const next = source[index + 1] ?? "";
      if (char === "\\" && DOUBLE_QUOTE_ESCAPES.has(next)) {
        word.value += next;
        index += 2;
        continue;
      }
      if (char === "`" || (char === "$" && next === "(")) {
        substitution = true;
      }
      word.value += char;
      index += 1;
    }
    return index + 1;
  };

  const redirect = (from: number): number => {
    // `2>file`: digits right before the operator are a file descriptor.
    if (word.start !== -1 && DIGITS.test(word.value)) {
      word.start = -1;
      word.value = "";
    }
    endWord(from);
    let index = from;
    while (REDIRECT_CHARS.has(source[index] ?? "")) {
      index += 1;
    }
    if (source[index] === "(") {
      // `<(cmd)` / `>(cmd)` process substitution.
      substitution = true;
      return index;
    }
    const duplicate = FD_DUPLICATE.exec(source.slice(index - 1));
    if (duplicate) {
      // `>&2`, `2>&1`, `>&-`: descriptor duplication, no target file.
      return index - 1 + duplicate[0].length;
    }
    word.redirect = true;
    return index;
  };

  /** Quotes and escapes continue the current word; `undefined` otherwise. */
  const quoted = (
    at: number,
    char: string,
    next: string
  ): number | undefined => {
    if (char === "'") {
      beginWord(at);
      const end = source.indexOf("'", at + 1);
      const stop = end === -1 ? source.length : end;
      word.value += source.slice(at + 1, stop);
      return stop + 1;
    }
    if (char === '"') {
      beginWord(at);
      return doubleQuoted(at + 1);
    }
    if (char === "\\") {
      beginWord(at);
      word.value += next;
      return at + 2;
    }
  };

  /** Consumes one token starting at `index`; returns the next index. */
  const step = (index: number): number => {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    const afterQuote = quoted(index, char, next);
    if (afterQuote !== undefined) {
      return afterQuote;
    }
    if (char === "`" || (char === "$" && next === "(")) {
      substitution = true;
    } else if (BLANK.test(char)) {
      endWord(index);
      return index + 1;
    } else if (char === ">" || char === "<" || (char === "&" && next === ">")) {
      return redirect(index);
    } else if (COMMAND_SEPARATORS.has(char)) {
      endCommand(index);
      return index + 1;
    }
    beginWord(index);
    word.value += char;
    return index + 1;
  };

  let cursor = 0;
  while (cursor < source.length) {
    cursor = step(cursor);
  }
  endCommand(source.length);
  return { commands, substitution };
};
