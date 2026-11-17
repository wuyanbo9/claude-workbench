# 工作台 · Claude Workbench

A side pane for Claude Code that keeps the person in charge in the loop when several sessions work together.

- **正在运行 / Running** — a strip at the top: which session is working on what, and since when. Every session that has the plugin shows up there by itself while it is working (its title and what it was asked); the coordinating session can add rows for others too.
- **待你处理 / Waiting for you** — cards for decisions (同意 / 不同意, or one button per option) and for actions only you can do (已完成). Pressing a button removes the card and sends your answer to the session that added the card, whichever session's pane you press it in.

Items live in the plugin's store, so every session sees the same list (refreshed every 15 seconds). The pane opens when a session starts and whenever something new arrives; `/todo` opens it any time.

Sessions fill it through the tool `mcp__owner-todo__owner_todo` (`add` with kind `decide`, `do` or `run`; `done`; `list`).

## Footer: stats and open issues

Under the cards, an **Issues** card shows how many GitHub issues are open in the session's repository; **Show** lists the newest 8 (number, title, age, and a ↗ that opens it in the browser). The shown/hidden state is remembered. At the very bottom, one small line of stats: lines of code · commits. When nothing is running and nothing waits, only the Issues card and the stats are shown.

- **Lines of code**: physical lines (as `wc -l`) of files tracked at `HEAD`, filtered by extension. Excluded: `dist/ build/ out/ .next/ vendor/ node_modules/ generated/ __generated__/`, `*.min.* *.d.ts *.pb.* *.g.* *.generated.*`, files marked `linguist-generated` / `linguist-vendored` in `.gitattributes`, files over 1 MB, and binary files. Recounted only when `HEAD` or the config changes.
- **Commits**: `git rev-list --count HEAD`.
- **Issues**: the open count and list, via `gh`. Without `gh`, a login, or a GitHub remote, the issue parts are simply not shown.
- Refreshed when the session starts and every 5 minutes while the pane is open. Nothing is written into the repository; a failure never shows an error.

Config lives in the plugin store under `stats`: `extensions` (replaces the default list), `exclude` (added to the default rules; `dir/` matches a path segment, anything else is a file-name glob), `maxFileBytes`.

## Install

At the prompt of a terminal session:

```
/plugin install owner-todo --marketplace wuyanbo9/claude-workbench
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install owner-todo --marketplace wuyanbo9/claude-workbench
```

## License

MIT
