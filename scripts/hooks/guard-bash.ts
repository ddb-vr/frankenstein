// PreToolUse hook (matcher `Bash|PowerShell`): heuristic second layer behind
// permissions and guard-files. Blocks shell commands that touch protected
// files or secrets (.env, *.pem), run interpreters outside the allowed entry
// points (so skill code never runs on the host), create symlinks, enter
// skill directories, or start containers outside the sandbox runner. Allowed
// entry points (exact, from the repo root, not fed by a pipe) pass.

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

/** `node scripts/<file>`: arguments follow and are validated by the script. */
const NODE_ENTRY_SCRIPTS: Record<string, true> = {
  "scripts/fix-skill.ts": true,
  "scripts/lock.ts": true,
  "scripts/record-fixture.ts": true,
  "scripts/registry.ts": true,
  "scripts/run-examples.ts": true,
  "scripts/run-skill.ts": true,
  "scripts/tracker.ts": true,
};
// Exact: extra arguments would reach `node --test` or the tools.
// `sandbox:build` only runs `docker build`.
const NPM_ENTRY_POINTS: readonly (readonly string[])[] = [
  ["npm", "test"],
  ["npm", "run", "check"],
  ["npm", "run", "typecheck"],
  ["npm", "run", "sandbox:build"],
];
const READ_ONLY_GIT: Record<string, true> = {
  blame: true,
  describe: true,
  diff: true,
  log: true,
  "ls-files": true,
  "rev-parse": true,
  show: true,
  status: true,
};
// `git diff --output=<file>` writes files; `--ext-diff` runs configured tools;
// `--no-index` reads any file, also outside the repo.
const GIT_UNTRUSTED_FLAG = /^--(output|ext-diff|no-index)/;
const CHANGE_DIR: Record<string, true> = {
  cd: true,
  chdir: true,
  pushd: true,
  "set-location": true,
  sl: true,
};

// Matched against lower-case, forward-slash text with quotes removed.
const PROTECTED = [
  "examples.json",
  "review.json",
  "registry.json",
  ".locks",
  ".claude",
];
// Budget state and review markers (`work/.run`): hooks write them, nobody else.
const RUN_STATE = /(^|[/=:])\.run(\/|$)/;
// `.env` and its variants (not `.env.example`), private keys.
const SECRET_FILE = /(^|[^a-z0-9_])\.env([^a-z0-9_]|$)|\.pem([^a-z0-9_]|$)/;
const SECRET_EXAMPLE = ".env.example";
const LINK_CLI = /(^|\/)(ln|link|mklink)(\.exe)?$/;
// PowerShell `New-Item -ItemType SymbolicLink` (also `-ItemType:Junction`).
const NEW_ITEM: Record<string, true> = { "new-item": true, ni: true };
const LINK_ITEM_TYPE = /(^|:)(symboliclink|junction|hardlink)$/;
// Directories holding generated or installed skill code (repo-relative).
const SKILL_CODE_DIRS = ["work", ".claude/skills", "fixtures/skills"];
const SKILL_CODE_REF =
  /(^|[/=:])(work|\.claude\/skills|fixtures\/skills)(\/|$)/;
// Interpreters run only as an entry point. Package managers count: `npm
// test -- <file>` is `node --test <file>`, `npm exec` is `npx`. `=` covers
// assignments and options (`X=node`, `--exec=node`).
const INTERPRETER =
  /(^|[/=])(node|nodejs|npx|tsx|ts-node(-esm)?|bun|bunx|deno|python[\d.]*|py|pypy[\d.]*|npm|pnpm|pnpx|yarn|corepack)(\.exe|\.cmd|\.bat)?$/;
// Inline code: `node -e/-p/--eval/--print/--input-type`, `python -c`.
const INLINE_CODE_FLAG = /^(-[ep]+|-c|--eval|--print|--input-type)(=.*)?$/;
const TEST_RUNNER_FLAG = /^--test(=|-|$)/;
// Other runtimes that could execute a skill file named in their arguments
// (shells are limited to `-c` separately).
const RUNTIME =
  /(^|\/)(node|nodejs|npx|npm|pnpm|pnpx|yarn|tsx|ts-node|deno|bun|bunx|python[\d.]*|py|perl|ruby|php)(\.exe|\.cmd|\.bat)?$/;
const SHELL = /(^|\/)(sh|bash|zsh|dash|ksh|fish|pwsh|powershell)(\.exe)?$/;
// `-c`, `-lc`, `-ec`, PowerShell `-command`.
const SHELL_COMMAND_FLAG = /^(-[a-z]*c[a-z]*|-command)$/;
const SOURCE: Record<string, true> = {
  ".": true,
  source: true,
};
// Not executable as a name: variables, substitutions, globs, placeholders.
const DYNAMIC_NAME = /[$`*?[{}%]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Variables that load code into an otherwise allowed interpreter or shell.
const CODE_LOADING_ENV =
  /^(node_options|node_path|node_repl_external_module|ld_preload|ld_library_path|dyld_[a-z_]+|pythonpath|pythonstartup|pythonhome|bash_env|env|npm_config_[a-z_]+)=/;
const CONTAINER_CLI = /(^|\/)(docker|podman)(\.exe)?$/;
const CONTAINER_START: Record<string, true> = {
  compose: true,
  create: true,
  exec: true,
  run: true,
  start: true,
};
const NETWORK_FLAG = /^--net(work)?(=|$)/;
const NESTED_COMMAND = /[\s;&|<>`]|\$\(/;
const SUBSTITUTION = /`|\$\(/;
const QUOTES = /["']/g;
const MAX_NESTING = 4;

// Commands whose arguments are data, never executed.
const DATA_COMMANDS: Record<string, true> = {
  cat: true,
  echo: true,
  egrep: true,
  fgrep: true,
  file: true,
  grep: true,
  head: true,
  ls: true,
  printf: true,
  stat: true,
  tail: true,
  type: true,
  wc: true,
  whereis: true,
  which: true,
};
// Message options of git / gh whose values are prose, not commands.
const MESSAGE_FLAGS: Record<string, true> = {
  "--body": true,
  "--message": true,
  "--subject": true,
  "--title": true,
  "-m": true,
};
const MESSAGE_TOOLS: Record<string, true> = {
  gh: true,
  git: true,
};

/**
 * Wrappers that run their operand as a command, with the options that take a
 * separate value word. `timeout` also takes a duration operand first.
 */
const WRAPPERS: Record<string, readonly string[]> = {
  builtin: [],
  caffeinate: ["-t", "-w"],
  command: [],
  doas: ["-C", "-u"],
  env: ["-C", "-P", "-S", "-u", "--chdir", "--split-string", "--unset"],
  // `eval "$CMD"`: its operand is the command; strings are expanded anyway.
  eval: [],
  exec: ["-a"],
  nice: ["-n", "--adjustment"],
  nohup: [],
  setsid: [],
  stdbuf: ["-e", "-i", "-o"],
  sudo: ["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u"],
  time: ["-f", "-o"],
  timeout: ["-k", "-s", "--kill-after", "--signal"],
  unbuffer: [],
  watch: ["-n", "--interval"],
  xargs: [
    "-a",
    "-d",
    "-E",
    "-I",
    "-J",
    "-L",
    "-n",
    "-P",
    "-R",
    "-S",
    "-s",
    "--arg-file",
    "--delimiter",
    "--max-args",
    "--max-procs",
  ],
};
// xargs replace string: `-I R`, `-IR`, `-J R`, `--replace=R`; `-i` and a bare
// `--replace` mean `{}`.
const XARGS_REPLACE = /^(-I|-J|--replace=)(.*)$/;
const XARGS_DEFAULT_REPLACE = /^(-i|--replace)$/;
const FIND_EXEC: Record<string, true> = {
  "-exec": true,
  "-execdir": true,
  "-ok": true,
  "-okdir": true,
};

const PROTECTED_REASON =
  "Blocked: shell access to protected files (examples.json, review.json, registry.json, work/.locks, work/.run, .claude). Use the Read tool to inspect them; lock with `node scripts/lock.ts <skill>`, install with `node scripts/registry.ts install <skill>`; run state is written only by the hooks.";
const SECRET_REASON =
  "Blocked: shell access to secrets (.env, *.pem). Scripts load .env themselves; never read, copy or print it (`.env.example` lists the variables).";
const SYMLINK_REASON =
  "Blocked: symlinks and hard links can redirect writes past the file guards; create real files and directories instead.";
const PIPED_ENTRY_REASON =
  "Blocked: entry points never read piped input. Pass the JSON as an argument (`node scripts/run-skill.ts <skill> '<json>'`) or use `--input-file <path>`.";
const HOST_EXEC_REASON =
  "Blocked: skill code never runs on the host. Test it in the sandbox with `node scripts/run-examples.ts work/<skill>`; use an installed skill with `node scripts/run-skill.ts <skill> '<json>'` (or `--input-file <path>`).";
const INTERPRETER_REASON =
  "Blocked: interpreters and package managers (node, npx, tsx, ts-node, bun, deno, python, npm) run only as an allowed entry point from the repo root: `node scripts/<run-examples|run-skill|registry|lock|tracker|record-fixture|fix-skill>.ts …`, `npm test`, `npm run check`, `npm run typecheck`. Test skill code with `node scripts/run-examples.ts work/<skill>`.";
const INLINE_CODE_REASON =
  "Blocked: inline code (`node -e/--eval/-p/--print/--input-type`, `python -c`) never runs on the host. Test skill code with `node scripts/run-examples.ts work/<skill>`.";
const TEST_RUNNER_REASON =
  "Blocked: `node --test` runs only as `npm test` (repo tests). Skill tests run in the sandbox: `node scripts/run-examples.ts work/<skill>`.";
const CWD_REASON =
  "Blocked: interpreters never run inside work/, .claude/skills/ or fixtures/skills/. Run allowed entry points from the repo root, e.g. `node scripts/run-examples.ts work/<skill>`.";
const CHANGE_DIR_REASON =
  "Blocked: do not cd into work/, .claude/skills/ or fixtures/skills/. Stay in the repo root and pass paths; inspect files with the Read and Glob tools.";
const DYNAMIC_REASON =
  "Blocked: command names built from variables, substitutions, globs or xargs/find placeholders cannot be verified. Spell the command out.";
const SHELL_REASON =
  "Blocked: shells run only as `bash -c '<command>'`; script files, `source`/`.` and commands piped into a shell are not executed on the host.";
const CODE_LOADING_ENV_REASON =
  "Blocked: NODE_OPTIONS, NODE_PATH, PYTHONPATH, LD_PRELOAD, DYLD_*, BASH_ENV and npm_config_* can load code into allowed commands; do not set them.";
const NESTING_REASON =
  "Blocked: command nested too deeply to verify. Run it directly.";
const CONTAINER_REASON =
  "Blocked: only the sandbox runner starts containers. Use `node scripts/run-examples.ts <skillDir>` or `node scripts/run-skill.ts <skill> '<json>'` (or `--input-file <path>`).";

/** Both spellings of a word, normalized for matching. */
const forms = (word: Word): string[] => [
  word.value.toLowerCase(),
  toPosixPath(word.raw.replace(QUOTES, "")).toLowerCase(),
];

const touchesProtected = (text: string): boolean =>
  PROTECTED.some((name) => text.includes(name)) || RUN_STATE.test(text);

const mentionsSecret = (text: string): boolean =>
  SECRET_FILE.test(text.replaceAll(SECRET_EXAMPLE, ""));

const matchesAny = (words: readonly Word[], test: (text: string) => boolean) =>
  words.some((word) => forms(word).some(test));

/** Lower-case command name, without path or Windows suffix kept. */
const lower = (word: Word | undefined): string =>
  word?.value.toLowerCase() ?? "";

/**
 * Words that may hold a command string (`sh -c '…'`, `eval`, `"$(…)"`).
 * A shell's `-c` script always counts (`bash -c "$Z"` runs whatever `$Z`
 * holds). Arguments of data commands and git/gh messages only when they
 * contain a substitution, which the shell runs before the command itself.
 */
const nestedSources = ({ words }: SimpleCommand): Word[] => {
  const name = lower(words[0]);
  const dataOnly = DATA_COMMANDS[name] === true;
  const runName = commandName(words).name;
  const shellScript =
    runName !== undefined && matchesAny([runName], (text) => SHELL.test(text))
      ? words[
          words.findIndex((word) => SHELL_COMMAND_FLAG.test(lower(word))) + 1
        ]
      : undefined;
  return words.filter((word, index) => {
    if (index > 0 && word === shellScript) {
      return true;
    }
    // A lone backtick marks a substitution split off by the parser.
    if (word.value === "`" || !NESTED_COMMAND.test(word.value)) {
      return false;
    }
    const isMessage =
      MESSAGE_TOOLS[name] === true &&
      (MESSAGE_FLAGS[lower(words[index - 1])] === true ||
        MESSAGE_FLAGS[lower(word).split("=")[0] ?? ""] === true);
    return dataOnly || isMessage ? SUBSTITUTION.test(word.value) : true;
  });
};

interface Expanded {
  commands: SimpleCommand[];
  tooDeep: boolean;
}

/** Adds the commands nested in words, up to `MAX_NESTING` levels. */
const expand = (commands: SimpleCommand[], depth = 0): Expanded => {
  const result: Expanded = { commands: [], tooDeep: false };
  for (const command of commands) {
    result.commands.push(command);
    const sources = nestedSources(command);
    if (sources.length === 0) {
      continue;
    }
    if (depth >= MAX_NESTING) {
      result.tooDeep = true;
      continue;
    }
    for (const word of sources) {
      const nested = expand(parseCommand(word.value).commands, depth + 1);
      result.commands.push(...nested.commands);
      result.tooDeep ||= nested.tooDeep;
    }
  }
  return result;
};

interface CommandName {
  name: Word | undefined;
  /** xargs replace string the name must not contain. */
  placeholder?: string;
}

/** Skips the options of a wrapper; returns the index of its operand. */
const skipWrapperOptions = (
  words: readonly Word[],
  from: number,
  wrapper: string,
  found: CommandName
): number => {
  const valueFlags = WRAPPERS[wrapper] ?? [];
  let index = from;
  while (index < words.length && (words[index]?.value ?? "").startsWith("-")) {
    const flag = words[index]?.value ?? "";
    if (wrapper === "xargs") {
      const replace = XARGS_REPLACE.exec(flag);
      if (replace) {
        found.placeholder = replace[2] || words[index + 1]?.value;
      } else if (XARGS_DEFAULT_REPLACE.test(flag)) {
        found.placeholder = "{}";
      }
    }
    index += valueFlags.includes(flag) ? 2 : 1;
  }
  return index;
};

/** The command actually run: past assignments and wrappers (`env`, `xargs`). */
const commandName = (words: readonly Word[]): CommandName => {
  const found: CommandName = { name: undefined };
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    const wrapper = lower(word);
    if (ASSIGNMENT.test(word?.value ?? "")) {
      index += 1;
    } else if (Object.hasOwn(WRAPPERS, wrapper)) {
      index = skipWrapperOptions(words, index + 1, wrapper, found);
      // `timeout 5 node …`: the duration comes before the command.
      index += wrapper === "timeout" ? 1 : 0;
    } else {
      found.name = word;
      return found;
    }
  }
  return found;
};

/** Names this simple command runs: its own and those of `find -exec`. */
const commandNames = (words: readonly Word[]): CommandName[] => {
  const names = [commandName(words)];
  for (const [index, word] of words.entries()) {
    if (FIND_EXEC[word.value] === true) {
      names.push(commandName(words.slice(index + 1)));
    }
  }
  return names;
};

const isDynamic = ({ name, placeholder }: CommandName): boolean =>
  name !== undefined &&
  (DYNAMIC_NAME.test(name.value) ||
    (placeholder !== undefined &&
      placeholder !== "" &&
      name.value.includes(placeholder)));

/** Exactly an allowed entry point, by word values. */
export const isEntryPoint = (words: readonly string[]): boolean => {
  if (words[0] === "git") {
    return (
      READ_ONLY_GIT[words[1] ?? ""] === true &&
      !words.some((word) => GIT_UNTRUSTED_FLAG.test(word))
    );
  }
  if (words[0] === "node") {
    return NODE_ENTRY_SCRIPTS[words[1] ?? ""] === true;
  }
  return NPM_ENTRY_POINTS.some(
    (entry) =>
      entry.length === words.length &&
      entry.every((part, index) => words[index] === part)
  );
};

/**
 * Runs node, python, npm, … in any form: as the command, behind a wrapper
 * (`env`, `xargs`, `find -exec`) or as an argument of an unknown wrapper.
 * Arguments of data commands (`grep node`, `which node`) are not run.
 */
const invokesInterpreter = ({ words }: SimpleCommand): boolean =>
  DATA_COMMANDS[lower(commandName(words).name)] !== true &&
  matchesAny(words, (text) => INTERPRETER.test(text));

/** A shell that would run a script file or stdin (no `-c`), or `source`. */
const runsShellScript = ({ words }: SimpleCommand): boolean =>
  commandNames(words).some(({ name }) => {
    if (name === undefined) {
      return false;
    }
    if (SOURCE[name.value] === true) {
      return true;
    }
    if (!matchesAny([name], (text) => SHELL.test(text))) {
      return false;
    }
    const rest = words.slice(words.indexOf(name) + 1);
    return !rest.some((word) => SHELL_COMMAND_FLAG.test(lower(word)));
  });

/** `cd` into a skill directory, or to a target that cannot be resolved. */
const entersSkillDir = (
  commands: readonly SimpleCommand[],
  cwd: string,
  root: string
): boolean =>
  commands.some(({ words }) => {
    if (CHANGE_DIR[lower(words[0])] !== true) {
      return false;
    }
    const target = words.slice(1).find((word) => !word.value.startsWith("-"));
    if (target === undefined || target.value === "~") {
      return false;
    }
    if (DYNAMIC_NAME.test(target.value)) {
      return true;
    }
    const relative = repoRelative(target.value, root, cwd);
    return (
      relative !== undefined &&
      SKILL_CODE_DIRS.some((dir) => isWithin(relative, dir))
    );
  });

/** Why an interpreter call is denied, most specific reason first. */
const interpreterReason = (
  interpreterCalls: readonly SimpleCommand[],
  inSkillDir: boolean,
  referencesSkillCode: boolean
): string => {
  const flags = interpreterCalls.flatMap(({ words }) => words.slice(1));
  if (matchesAny(flags, (text) => INLINE_CODE_FLAG.test(text))) {
    return INLINE_CODE_REASON;
  }
  if (matchesAny(flags, (text) => TEST_RUNNER_FLAG.test(text))) {
    return TEST_RUNNER_REASON;
  }
  if (inSkillDir) {
    return CWD_REASON;
  }
  return referencesSkillCode ? HOST_EXEC_REASON : INTERPRETER_REASON;
};

/** Splits off trusted entry points; returns the rest, or a deny reason. */
const untrustedCommands = (
  commands: readonly SimpleCommand[],
  entriesTrusted: boolean
): SimpleCommand[] | string => {
  const checked: SimpleCommand[] = [];
  for (const simple of commands) {
    if (
      entriesTrusted &&
      isEntryPoint(simple.words.map((word) => word.value))
    ) {
      // `echo … | node scripts/run-skill.ts …`: the input would bypass the
      // script's own argument checks.
      if (simple.piped) {
        return PIPED_ENTRY_REASON;
      }
      // Their arguments are validated by the scripts; redirects are not.
      if (matchesAny(simple.redirects, touchesProtected)) {
        return PROTECTED_REASON;
      }
    } else {
      checked.push(simple);
    }
  }
  return checked;
};

/** `ln`, `link`, `mklink` or PowerShell `New-Item -ItemType SymbolicLink`. */
const createsLink = ({ words }: SimpleCommand): boolean =>
  commandNames(words).some(
    ({ name }) =>
      name !== undefined && matchesAny([name], (text) => LINK_CLI.test(text))
  ) ||
  (NEW_ITEM[lower(words[0])] === true &&
    matchesAny(words, (text) => LINK_ITEM_TYPE.test(text)));

const startsContainer = (
  commands: readonly SimpleCommand[],
  allWords: readonly Word[]
): boolean =>
  commands.some(
    ({ words }) =>
      matchesAny(words, (text) => CONTAINER_CLI.test(text)) &&
      words.some((word) => CONTAINER_START[lower(word)] === true)
  ) || matchesAny(allWords, (text) => NETWORK_FLAG.test(text));

/** Host execution of skill code by other runtimes or by path. */
const runsSkillCode = (
  commands: readonly SimpleCommand[],
  inSkillDir: boolean
): boolean =>
  commands.some(({ words }) => {
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

export const checkCommand = (
  command: string,
  cwd: string,
  root: string
): Decision => {
  const parsed = parseCommand(command);
  const cwdRelative = repoRelative(cwd, root);
  const inSkillDir =
    cwdRelative !== undefined &&
    SKILL_CODE_DIRS.some((dir) => isWithin(cwdRelative, dir));
  const changesDir = parsed.commands.some(
    (simple) => CHANGE_DIR[lower(simple.words[0])] === true
  );
  // Entry points are relative paths: trusted only from the repo root, with
  // no substitution or directory change in the same command line.
  const entriesTrusted =
    cwdRelative === "" && !(parsed.substitution || changesDir);
  const checked = untrustedCommands(parsed.commands, entriesTrusted);
  if (typeof checked === "string") {
    return checked;
  }

  const { commands, tooDeep } = expand(checked);
  if (tooDeep) {
    return NESTING_REASON;
  }
  if (entersSkillDir(commands, cwd, root)) {
    return CHANGE_DIR_REASON;
  }
  const allWords = commands.flatMap((simple) => [
    ...simple.words,
    ...simple.redirects,
  ]);
  // Trusted entry points included: their arguments must not name secrets.
  const topWords = parsed.commands.flatMap((simple) => [
    ...simple.words,
    ...simple.redirects,
  ]);
  const everyWord = [...allWords, ...topWords];
  if (matchesAny(everyWord, (text) => CODE_LOADING_ENV.test(text))) {
    return CODE_LOADING_ENV_REASON;
  }
  if (matchesAny(everyWord, mentionsSecret)) {
    return SECRET_REASON;
  }
  if (matchesAny(allWords, touchesProtected)) {
    return PROTECTED_REASON;
  }
  if (commands.some(createsLink)) {
    return SYMLINK_REASON;
  }
  if (startsContainer(commands, allWords)) {
    return CONTAINER_REASON;
  }
  const referencesSkillCode =
    inSkillDir || matchesAny(allWords, (text) => SKILL_CODE_REF.test(text));
  const interpreterCalls = commands.filter(invokesInterpreter);
  if (interpreterCalls.length > 0) {
    return interpreterReason(interpreterCalls, inSkillDir, referencesSkillCode);
  }
  if (commands.some(({ words }) => commandNames(words).some(isDynamic))) {
    return DYNAMIC_REASON;
  }
  if (commands.some(runsShellScript)) {
    return SHELL_REASON;
  }
  if (referencesSkillCode && runsSkillCode(commands, inSkillDir)) {
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
