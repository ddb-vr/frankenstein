---
name: line-count
description: Counts the lines of a mounted text file in a given encoding. Internal fixture for input/output mounts; never installed.
---

# line-count

Input: `{ "file": string, "encoding"?: string }` on stdin. `file` is the path given in the input (`/input/<name>` at
runtime, `/skill/fixtures/input/<name>` in tests); `encoding` defaults to `utf-8` (e.g. `windows-1250` for Czech bank
exports) and is decoded strictly.

Output: `{ "file", "firstLine", "lines", "output" }` on stdout. When `/output` exists, the numbered UTF-8 lines go to
`/output/<name>.lines.txt` and `output` names that file; otherwise `output` is `null`. Unreadable file, missing
`file` or bytes invalid in the encoding → `{ "error": "..." }` and exit code 1.

```sh
node scripts/run-examples.ts fixtures/skills/line-count   # never installed, so never via run-skill
```
