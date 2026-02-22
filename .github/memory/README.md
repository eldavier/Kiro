# Agent Team Memory

This directory contains the **persistent shared memory** for the agent team. These are living Markdown documents that both **you and agents** can read and write.

## How It Works

- **You can edit any file directly** — add preferences, rules, context, or corrections. Your entries are authoritative and always take priority.
- **Agents update memory automatically** — whenever they discover something important (a convention, an error fix, an architecture insight), they write it immediately. They don't wait until the end of a mission.
- **When you tell an agent something important** in chat (a preference, a rule, a decision), the agent records it in the appropriate memory file right away.
- **Memory survives across sessions** — everything persists in these files.

## Memory Files

| File | Purpose | Who Writes |
|------|---------|------------|
| `architecture.md` | Architecture patterns, structure, subsystem knowledge | You, Analyser |
| `conventions.md` | Coding style, naming conventions, best practices | You, Analyser, Coder |
| `decisions.md` | Design decisions, trade-offs, and rationale | You, Planner, Orchestrator |
| `dependencies.md` | Module dependency maps, import relationships | You, Analyser |
| `errors.md` | Known error patterns and verified fixes | You, Coder |
| `missions.md` | Completed mission log with outcomes | Orchestrator |
| `user-preferences.md` | Your preferences and working style | You, any agent |

## Rules

1. **Your edits are king** — If you write or change something, agents respect it unconditionally.
2. **Read before every mission** — The Orchestrator reads all memory files at Step 1 and passes relevant excerpts to agents.
3. **Write immediately** — Agents write to memory the moment they learn something important, not at the end.
4. **Record user instructions** — When you tell an agent a preference or rule, it goes into memory immediately.
5. **Append-only for agents** — Agents never delete entries. They mark outdated ones `[OUTDATED]` and add corrections. You can freely delete, reorganise, or rewrite anything.
6. **Use the template format** — Each file has a comment template showing the expected entry format.
7. **Include the mission-id** — Every agent entry links back to the mission. Your entries can use `direct-instruction`.
8. **Keep entries concise** — Quality over quantity. One clear finding per entry.
