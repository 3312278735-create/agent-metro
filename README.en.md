<div align="center">

# Agent Metro

**One metro map for all your projects. AI agents do the work, you sign off, stations turn green.**

One project = one line. One task = one station. Done = the station turns green.<br>
Built for "AI agents do the work, a human signs off": Claude Code / Cursor / Trae work inside each project and report back to one metro map.

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![Zero dependencies](https://img.shields.io/badge/dependencies-zero-blue)
![Plain-text ledger](https://img.shields.io/badge/ledger-plain%20Markdown-orange)

[简体中文](README.md) · English

<img src="docs/demo.gif" alt="Open a station, accept it, it arrives" width="860">

> The UI and the bundled AI rules are in Chinese. The ledger format and commands below work the same in any language.

</div>

## Why

Run a handful of projects with an AI agent in each, and it gets messy fast:

- **What is actually done?** Every agent says "done", but nobody has checked.
- **What is waiting on me?** Decisions and reviews are buried in dozens of chat threads.
- **Agents don't stop.** A small feature gets polished for a whole afternoon.

This tool keeps every task in **one plain-text ledger** (`TODO.md`, readable and writable by both humans and agents), draws it as a metro map, and gives the agents house rules: hand over acceptance criteria when you finish, and wrap up when your time is up.

## Features

- 🚇 **Metro map** — green = arrived, orange = waiting for your review, blue = in progress, grey = not started. Click a station to change its status or leave a note.
- ✅ **Human sign-off** — an agent's "done" goes to *pending review* with "how to check / what you should see". It only arrives when you say so. Low-stakes tasks the agent can verify itself can be *auto-accepted* and are labelled as such.
- ⏱️ **Conveyor belt** — every task gets a time budget (30m / 1h / 2h). The clock starts when work starts; when it runs out, the agent wraps up. Reviews get two days, then drop into a "review basket" without blocking anything else.
- 💬 **Progress card** — Claude Code ends each reply with a small card: where this line is, what the agent is doing, what's next, what needs your decision.
- 📝 **Full history** — every click on the map is appended to `HISTORY.md`, which the agent reads at the start of each session; the ledger is backed up before every write.
- 🔌 **Tool-agnostic** — the rules are plain Markdown (`PROTOCOL.md`), so Claude Code, Cursor, Trae and Codex can all follow them.
- 🔒 **Local only** — a zero-dependency Node.js server bound to `127.0.0.1`; the data is a few Markdown files you can keep in git.

<table>
<tr>
<td width="50%"><img src="docs/station.png" alt="Station details"><br><sub>Station details: change status, add a note</sub></td>
<td width="50%"><img src="docs/progress-card.png" alt="Progress card"><br><sub>Progress card at the end of a Claude Code reply</sub></td>
</tr>
</table>

## Quick start

Requires [Node.js](https://nodejs.org) 18+. No dependencies, no `npm install`.

```bash
git clone https://github.com/3312278735-create/agent-metro.git
cd agent-metro
node tools/board-server.js        # Windows: just double-click 打开地铁图.bat
```

Open http://127.0.0.1:47615/ to see the demo ledger (two sample projects). Mainly used on Windows so far; on macOS / Linux run with `--no-open` and open the URL yourself.

To use your own projects: delete the sample task lines in `TODO.md` (keep the section headings) and reset `next_task_id` to `T001`; create one page per project under `projects/` (set `path:` to the project folder); clear the samples in `ARCHIVE.md`, `HISTORY.md` and `pins.json`.

## Ledger format

One line in `TODO.md` is one station:

```markdown
- [ ] #T005 MyGame｜Save system—write level progress to disk due:2026-10-12T18:00 status:doing priority:P1 exec:mixed created:2026-10-10 budget:2h
```

The text before `｜` is the project (the line); `status` is `todo` / `doing` / `review` / `done` / `paused`; keep `due` → `status` → `priority` in that order.

```bash
node tools/ledger.js set-status T005 review "save system ready for review"
node tools/ledger.js set-status T005 done --me    # you accepted it
node tools/ledger.js set-budget T006 1h           # time budget; clock starts on "doing"
node tools/ledger.js belt                         # what's overdue / waiting too long
```

## Hooking up your AI agents

Paste [`claude/全局规则片段.md`](claude/全局规则片段.md) into `~/.claude/CLAUDE.md` (replace `<看板目录>` with the path to this repo), optionally copy `claude/skills/open-review/` into `~/.claude/skills/`, and add the "dashboard link" section from that file to each project's `AGENTS.md`. The reporting protocol lives in [`PROTOCOL.md`](PROTOCOL.md).

## License

[MIT](LICENSE)
