# 工作台 · Claude Workbench

A side pane for Claude Code that keeps the person in charge in the loop when several sessions work together.

- **正在运行 / Running** — a strip at the top: which session is working on what, and since when. Every session that has the plugin shows up there by itself while it is working (its title and what it was asked); the coordinating session can add rows for others too.
- **待你处理 / Waiting for you** — cards for decisions (同意 / 不同意, or one button per option) and for actions only you can do (已完成). Pressing a button removes the card and sends your answer to the session the pane is in.

Items live in the plugin's store, so every session sees the same list (refreshed every 15 seconds). The pane opens when a session starts and whenever something new arrives; `/todo` opens it any time.

The coordinating session fills it through the tool `mcp__owner-todo__owner_todo` (`add` with kind `decide`, `do` or `run`; `done`; `list`). Other sessions only read it.

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
