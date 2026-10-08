// PreToolUse hook (matcher `Bash|PowerShell`): heuristic second layer behind
// permissions and guard-files. Blocks shell commands that touch protected
// files, execute skill code on the host, or start containers outside the
// sandbox runner. Allowed entry points (exact, from the repo root) pass.

import {
  type Decision,
  type HookInput,
  isWithin,
  REPO_ROOT,
  repoRelative,
  runHook,
  toPosixPath,
} from "./lib.ts";
import { parseCommand, type SimpleCommand, type Word } from "./shell.ts";

const ENTRY_POINTS: readonly (readonly string[])[] = [
  ["node", "scripts/run-examples.ts"],
  ["node", "scripts/run-skill.ts"],
  ["node", "scripts/registry.ts"],
  ["node", "scripts/lock.ts"],
  ["node", "scripts/tracker.ts"],
  ["node", "scripts/record-fixture.ts"],
  ["npm", "test"],
  ["npm", "run", "check"],
  ["npm", "run", "typecheck"],
];
const READ_ONLY_GIT = new Set([
  "blame",
  "describe",
  "diff",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);
// `git diff --output=<file>` writes files; `--ext-diff` runs configured tools.
const GIT_WRITE_FLAG = /^--(output|ext-diff)/;
const CHANGE_DIR = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);

// Matched against lower-case, forward-slash text with quotes removed.
const PROTECTED = [
  "examples.json",
  "review.json",
  "registry.json",
  ".locks",
  ".claude",
];
// Directories holding generated or installed skill code.
const SKILL_CODE_DIRS = ["work", ".claude/skills", "fixtures/skills"];
const SKILL_CODE_REF =
  /(^|[/=:])(work|\.claude\/skills|fixtures\/skills)(\/|$)/;
// Interpreters / package runners, optionally with a path or Windows suffix.
const RUNTIME =
  /(^|\/)(node|nodejs|npx|npm|pnpm|pnpx|yarn|tsx|ts-node|deno|bun|bunx|python[\d.]*|py|sh|bash|zsh|pwsh|powershell)(\.exe|\.cmd|\.bat)?$/;
const CONTAINER_CLI = /(^|\/)(docker|podman)(\.exe)?$/;
const CONTAINER_START = new Set(["run", "create", "start", "exec", "compose"]);
const NETWORK_FLAG = /^--net(work)?(=|$)/;
const NESTED_COMMAND = /[\s;&|<>`]|\$\(/;
const QUOTES = /["']/g;
const MAX_NESTING = 2;

const PROTECTED_REASON =
  "Blocked: shell access to protected files (examples.json, review.json, registry.json, work/.locks, .claude). Use the Read tool to inspect them; lock with `node scripts/lock.ts <skill>`, install with `node scripts/registry.ts install <skill>`.";
const HOST_EXEC_REASON =
  "Blocked: skill code never runs on the host. Test it in the sandbox with `node scripts/run-examples.ts work/<skill>`; use an installed skill with `node scripts/run-skill.ts <name> '<json>'`.";
const CONTAINER_REASON =
  "Blocked: only the sandbox runner starts containers. Use `node scripts/run-examples.ts <skillDir>` or `node scripts/run-skill.ts <name> '<json>'`.";

/** Both spellings of a word, normalized for matching. */
const forms = (word: Word): string[] => [
  word.value.toLowerCase(),
  toPosixPath(word.raw.replace(QUOTES, "")).toLowerCase(),
];

const matchesAny = (words: readonly Word[], test: (text: string) => boolean) =>
  words.some((word) => forms(word).some(test));

/** Expands words that are command strings themselves (`sh -c '…'`, `eval`). */
const expand = (commands: SimpleCommand[], depth = 0): SimpleCommand[] =>
  commands.flatMap((command) => {
    const nested =
      depth < MAX_NESTING
        ? command.words
            .filter((word) => NESTED_COMMAND.test(word.value))
            .flatMap((word) =>
              expand(parseCommand(word.value).commands, depth + 1)
            )
        : [];
    return [command, ...nested];
  });

/** Exactly an allowed entry point, by word values. */
export const isEntryPoint = (words: readonly string[]): boolean => {
  if (words[0] === "git") {
    return (
      READ_ONLY_GIT.has(words[1] ?? "") &&
      !words.some((word) => GIT_WRITE_FLAG.test(word))
    );
  }
  return ENTRY_POINTS.some((entry) =>
    entry.every((part, index) => words[index] === part)
  );
};

export const checkCommand = (
  command: string,
  cwd: string,
  root: string
): Decision => {
  const parsed = parseCommand(command);
  const cwdRelative = repoRelative(cwd, root);
  const changesDir = parsed.commands.some((simple) =>
    CHANGE_DIR.has(simple.words[0]?.value.toLowerCase() ?? "")
  );
  // Entry points are relative paths: trusted only from the repo root, with
  // no substitution or directory change in the same command line.
  const entriesTrusted =
    cwdRelative === "" && !(parsed.substitution || changesDir);
  const checked: SimpleCommand[] = [];
  for (const simple of parsed.commands) {
    if (
      entriesTrusted &&
      isEntryPoint(simple.words.map((word) => word.value))
    ) {
      // Their arguments are validated by the scripts; redirects are not.
      if (
        matchesAny(simple.redirects, (text) =>
          PROTECTED.some((name) => text.includes(name))
        )
      ) {
        return PROTECTED_REASON;
      }
    } else {
      checked.push(simple);
    }
  }

  const commands = expand(checked);
  const allWords = commands.flatMap((simple) => [
    ...simple.words,
    ...simple.redirects,
  ]);
  if (
    matchesAny(allWords, (text) =>
      PROTECTED.some((name) => text.includes(name))
    )
  ) {
    return PROTECTED_REASON;
  }

  const startsContainer = commands.some(
    ({ words }) =>
      matchesAny(words, (text) => CONTAINER_CLI.test(text)) &&
      words.some((word) => CONTAINER_START.has(word.value.toLowerCase()))
  );
  if (
    startsContainer ||
    matchesAny(allWords, (text) => NETWORK_FLAG.test(text))
  ) {
    return CONTAINER_REASON;
  }

  const inSkillDir =
    cwdRelative !== undefined &&
    SKILL_CODE_DIRS.some((dir) => isWithin(cwdRelative, dir));
  const referencesSkillCode =
    inSkillDir || matchesAny(allWords, (text) => SKILL_CODE_REF.test(text));
  const runsCode = commands.some(({ words }) => {
    const [first] = words;
    // Direct execution of a script path (`./main.ts`, `work/x/main.ts`).
    const directExec =
      first !== undefined &&
      matchesAny(
        [first],
        (text) =>
          text.includes("/") && (inSkillDir || SKILL_CODE_REF.test(text))
      );
    return directExec || matchesAny(words, (text) => RUNTIME.test(text));
  });
  if (referencesSkillCode && runsCode) {
    return HOST_EXEC_REASON;
  }
};

export const checkShell = (input: HookInput, root: string): Decision => {
  const { command } = input.tool_input;
  if (typeof command !== "string") {
    return `Blocked: ${input.tool_name} call without a command.`;
  }
  return checkCommand(command, input.cwd, root);
};

if (import.meta.main) {
  runHook((input) => checkShell(input, REPO_ROOT));
}
