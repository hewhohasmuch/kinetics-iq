# AGENTS.md

The instructions for this repository live in **[`CLAUDE.md`](CLAUDE.md)** — commands, architecture, measurement limitations, and testing. Read it before changing anything; it applies to any coding agent, not only Claude Code.

This file is deliberately a pointer rather than a copy. An earlier copy drifted within weeks and gave wrong advice (a missing migration, the old sync-failure behaviour), which is worse than no file.

Wherever `CLAUDE.md` names a skill, the skill itself lives in `.claude/skills/<name>/SKILL.md`. The entries under `.agents/skills/` are pointers to those files.
