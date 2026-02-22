---
description: "Communication protocol for the dedicated agent team. Ensures structured message passing between Orchestrator, Analyser, Planner, Skill Attributer, and Senior Coder agents so no context is lost."
applyTo: "**"
---

# Agent Team Communication Protocol

## Overview

This workspace uses a **dedicated agent team** of five specialised agents that collaborate on complex tasks. Every agent MUST follow this protocol when communicating with other agents to prevent context loss.

## Shared Team Memory

The team has a **persistent shared memory** stored in `.github/memory/`. These are living documents that survive across missions — agents read them at the start of work and write to them **immediately** whenever they learn something important.

**Memory is a two-way system**: the user can edit memory files directly (adding preferences, corrections, or context), and agents update them automatically during work. Memory files are standard Markdown — open and edit them anytime.

### Memory Files

| File | Purpose | Writers |
|------|---------|--------|
| `architecture.md` | Architecture patterns, subsystem structure, key abstractions | User, Analyser |
| `conventions.md` | Coding style, naming rules, best practices | User, Analyser, Coder |
| `decisions.md` | Design decisions, trade-offs, rationale | User, Planner, Orchestrator |
| `dependencies.md` | Module dependency maps, import relationships | User, Analyser |
| `errors.md` | Known error patterns and verified fixes | User, Coder |
| `missions.md` | Completed mission log with outcomes | Orchestrator |
| `user-preferences.md` | User preferences, working style, explicit instructions | User, Orchestrator, ANY agent |

### Memory Rules

1. **Read at mission start.** The Orchestrator MUST read all memory files at Step 1 and pass relevant excerpts to agents in `<context>` blocks.
2. **Write IMMEDIATELY when you learn something important.** Do NOT wait until the end of a mission. If an agent discovers a convention, encounters an error, or receives an important instruction from the user — write it to memory RIGHT AWAY using `edit` or `execute`.
3. **Record user instructions.** When the user tells an agent something important (a preference, a rule, a correction, a decision), the agent MUST immediately write it to the appropriate memory file — usually `user-preferences.md` for preferences, `conventions.md` for coding rules, or `decisions.md` for design choices.
4. **User edits are authoritative.** If the user directly edits a memory file, their changes take priority over any agent-written entry. Agents MUST respect user-written entries.
5. **Append-only for agents.** Agents never delete entries. If something is outdated, prefix the entry title with `[OUTDATED]` and add the correction as a new entry. The user may delete or reorganise entries freely.
6. **Use the template.** Each memory file has a comment template showing the expected entry format. Follow it.
7. **Include mission-id.** Every entry links back to the mission that produced it. User-added entries can use `direct-instruction` as the mission-id.
8. **Keep entries concise.** One clear finding per entry. Quality over quantity.
9. **Check before rediscovering.** Before investigating something, check if it's already in memory.
10. **Update, don't duplicate.** If an existing entry covers the same topic, mark it `[OUTDATED]` and write the updated version rather than creating a near-duplicate.

### Memory Refresh During Long Missions

On long missions (many agent invocations), memory context can get stale or truncated. These rules prevent memory loss:

1. **Orchestrator checkpoints.** After every agent interaction, the Orchestrator MUST update `.github/memory/.current-mission.md` with the current mission state (progress, decisions, file tracker, open questions). This file is a running checkpoint that survives context loss.
2. **Re-read before every agent call on long missions.** If the mission's sequence counter reaches **4 or higher**, the Orchestrator MUST re-read all memory files fresh before composing the next `<team-message>`. Do NOT rely on excerpts cached from Step 1.
3. **Agents self-refresh.** If an agent receives a `<team-message>` with `<sequence>` 4 or higher, it MUST re-read the relevant memory files directly using the `read` tool rather than relying solely on the `<memory-context>` provided. The `<memory-context>` may be stale or incomplete on long missions.
4. **Compact summaries.** When the mission gets long, the Orchestrator should summarise earlier agent outputs rather than forwarding them verbatim. But NEVER summarise memory — always provide the latest raw memory content.
5. **Current mission file.** `.github/memory/.current-mission.md` is overwritten (not appended) at each checkpoint. It tracks: mission ID, current sequence, progress table, active memory highlights, decisions made, file tracker state, and open questions.

### Memory in Messages

When the Orchestrator sends a `<team-message>`, it MUST include a `<memory-context>` block with relevant excerpts from memory:

```xml
<team-message>
  <from>Orchestrator</from>
  <to>Coder</to>
  <mission-id>fix-auth-flow</mission-id>
  <sequence>5</sequence>
  <memory-context>
    <!-- Relevant entries from .github/memory/ -->
    [conventions.md] Always use ErrKind wrapper for public API errors
    [errors.md] Auth token refresh race condition — fixed by adding mutex in session.ts
    [user-preferences.md] User prefers explicit error messages, never silent failures
  </memory-context>
  <context>...</context>
  <task>...</task>
  <expected-output>...</expected-output>
</team-message>
```

When an agent discovers something worth remembering, it MUST include a `<memory-write>` block in its `<team-response>`:

```xml
<team-response>
  ...
  <memory-write>
    <target>conventions.md</target>
    <entry>
## [2026-02-21] Service injection pattern
- **Mission**: fix-auth-flow
- **Agent**: Analyser
- **Rule**: All services use constructor injection via @IServiceIdentifier decorators
- **Example**: `constructor(@IAuthService private readonly authService: IAuthService)`
- **Anti-pattern**: Never use service locator pattern or global getService()
    </entry>
  </memory-write>
</team-response>
```

The Orchestrator is responsible for applying `<memory-write>` blocks by appending entries to the target file.

## Team Members

| Agent | Role | Can Invoke |
|-------|------|------------|
| **Orchestrator** | Central coordinator & state keeper | Analyser, Planner, SkillAttributer, Coder |
| **Analyser** | Deep codebase analysis & pattern detection | _(leaf agent)_ |
| **Planner** | Structured implementation planning | Analyser |
| **SkillAttributer** | Task decomposition & skill-based routing | Analyser |
| **Coder** | Senior-level implementation & testing | Analyser |

## Message Envelope Format

When one agent calls another via `runSubagent`, the prompt MUST use this structured envelope so the receiving agent has full context:

```xml
<team-message>
  <from>CallingAgentName</from>
  <to>TargetAgentName</to>
  <mission-id>short-slug-describing-the-goal</mission-id>
  <sequence>N</sequence>            <!-- incremented per message in this mission -->
  <context>
    Prior findings, decisions, and constraints gathered so far.
    Include summaries from previous agent responses — never assume
    the next agent has seen them.
  </context>
  <task>
    Specific instruction for this agent. Be precise.
  </task>
  <expected-output>
    Description of the structured output expected back.
  </expected-output>
</team-message>
```

## Response Envelope Format

Every agent MUST return its results wrapped in this envelope so the caller can parse and forward context:

```xml
<team-response>
  <from>RespondingAgentName</from>
  <mission-id>same-slug</mission-id>
  <sequence>N</sequence>
  <status>complete | needs-more-info | blocked | partial</status>
  <summary>
    One-paragraph executive summary of findings/results.
  </summary>
  <details>
    Full structured output (analysis, plan, code, etc.)
  </details>
  <open-questions>
    Any unresolved items the caller should address.
  </open-questions>
  <handoff-recommendation>
    Which agent should act next and what they should do.
  </handoff-recommendation>
</team-response>
```

## Communication Rules

1. **Never assume shared state.** Each subagent invocation is stateless. Always pass the full relevant context in the `<context>` block.
2. **Summarise before forwarding.** When the Orchestrator passes Agent A's output to Agent B, it must include a summary — not just raw output.
3. **Increment the sequence number.** This prevents agents from confusing which step of the workflow they're on.
4. **Use the mission-id consistently.** All messages in one user request share the same mission-id.
5. **Return structured output.** Every response uses the `<team-response>` envelope. No free-form replies.
6. **Flag uncertainty.** If an agent is unsure, it sets `<status>needs-more-info</status>` and fills `<open-questions>`.
7. **Recommend next steps.** Every response includes `<handoff-recommendation>` so the Orchestrator knows what to do next.

## Standard Workflow

```
User Request
    │
    ▼
┌─────────────┐
│ Orchestrator │◄──────────────────────────────────┐
│  (coordinator)                                    │
└──────┬──────┘                                     │
       │ 1. Invokes Analyser                        │
       ▼                                            │
┌─────────────┐                                     │
│  Analyser   │─── returns analysis ────────────────┤
└─────────────┘                                     │
       │ 2. Orchestrator invokes Planner            │
       ▼          (with analysis context)           │
┌─────────────┐                                     │
│   Planner   │─── returns plan ────────────────────┤
└─────────────┘                                     │
       │ 3. Orchestrator invokes SkillAttributer    │
       ▼          (with plan context)               │
┌──────────────────┐                                │
│ SkillAttributer  │─── returns task assignments ───┤
└──────────────────┘                                │
       │ 4. Orchestrator invokes Coder              │
       ▼          (with plan + assignments)         │
┌─────────────┐                                     │
│    Coder    │─── returns implementation ──────────┘
└─────────────┘
       │
       ▼
  Orchestrator synthesises final response to user
```

## File Completion Tracker

Every mission MUST maintain a **File Tracker** — a living checklist of all files in the plan. This ensures agents know exactly which files are done, which are in progress, and which are pending.

### Tracker Format

The Planner creates the initial tracker. The Coder updates it after each file is fully implemented. The Orchestrator includes the current tracker state in every subsequent `<team-message>`.

```markdown
## File Tracker
| # | File | Action | Status | Implemented By | Notes |
|---|------|--------|--------|----------------|-------|
| 1 | `src/foo.ts` | Modify | ✅ DONE | Coder (seq 4) | Added export, verified compile |
| 2 | `src/bar.ts` | Create | ✅ DONE | Coder (seq 4) | New module, 120 lines |
| 3 | `src/baz.ts` | Modify | 🔧 IN PROGRESS | Coder (seq 6) | Halfway done, blocked on #4 |
| 4 | `tests/baz.test.ts` | Create | ⬚ PENDING | — | Waiting for #3 |
```

### Status Values
- **⬚ PENDING** — Not yet started
- **🔧 IN PROGRESS** — Currently being implemented
- **✅ DONE** — Fully implemented, compiled, verified
- **❌ BLOCKED** — Cannot proceed (explain in Notes)
- **⏭️ SKIPPED** — Intentionally not implemented (explain in Notes)

### Rules
1. **Planner** creates the initial tracker with all files set to `⬚ PENDING`.
2. **Coder** MUST update the tracker after completing EACH file — never batch completions. A file is only `✅ DONE` when:
   - All planned changes are implemented
   - The file compiles without errors
   - The file has been read back to verify correctness
3. **Orchestrator** includes the current tracker in every `<context>` block sent to agents.
4. **Orchestrator** checks the tracker before declaring mission complete — ALL must-have files must be `✅ DONE`.
5. The tracker is included inside `<team-response>` in a `<file-tracker>` block.

### Response Envelope Addition

Every `<team-response>` that touches file state MUST include:

```xml
<file-tracker>
| # | File | Action | Status | Implemented By | Notes |
|---|------|--------|--------|----------------|-------|
| 1 | `path/file.ts` | Modify | ✅ DONE | Coder (seq N) | ... |
| 2 | `path/other.ts` | Create | ⬚ PENDING | — | ... |
</file-tracker>
```

## Context Management & Continuation

Each agent has a **finite context window** (token limit). On large missions, agents can approach this limit. The team MUST detect this proactively and hand off to a fresh session without losing progress.

### Context Budget Tracking

The Orchestrator tracks a **context budget counter** — a rough estimate of how much context has been consumed:

| Metric | Weight | Explanation |
|--------|--------|-------------|
| Each `<team-message>` sent | +1 | Outbound context |
| Each `<team-response>` received | +2 | Inbound context (usually larger) |
| Each file read by Orchestrator | +1 | Direct reads add to context |
| Memory re-reads (sequence ≥ 4) | +1 | Full memory refreshes |

The Orchestrator maintains this counter in `.github/memory/.current-mission.md` under the `Current Sequence` field.

### Context Threshold Detection

A **context handoff** is triggered when ANY of these conditions are true:

1. **Sequence counter reaches 10 or higher.** This is the primary trigger — after 10 agent interactions, context is likely 60-80% consumed.
2. **Agent response is truncated.** If a `<team-response>` appears cut off (missing `</team-response>` closing tag, or `<status>` is absent), context overflow may have occurred.
3. **Orchestrator detects repetition.** If the Orchestrator finds itself re-explaining the same context that was already sent 2+ interactions ago, the context window is getting saturated.
4. **Agent returns `status: context-limit`.** Any agent MAY self-report that it is running low on context by returning this status.

### Handoff Protocol

When a context handoff is triggered:

1. **Orchestrator writes `.context-continuation.md`** — overwriting the file with a compact snapshot:
   - Mission ID, phase completed, phase starting
   - Compact summaries (NOT full transcripts) of all completed agent outputs
   - Current file tracker state (full table)
   - Active memory highlights
   - Decisions carried forward
   - Open questions
   - Explicit "Next Actions" instruction for the resuming session

2. **Orchestrator updates `.current-mission.md`** — marks `Trigger Reason: context-handoff`

3. **Orchestrator writes all pending `<memory-write>` blocks** to their target files BEFORE ending. Memory must be persisted — it's the primary survival mechanism.

4. **Orchestrator tells the user**: "Context limit approaching. I've saved all progress. Please start a new chat and say: **Continue mission `<mission-id>`**." Include a one-paragraph summary of what's done and what remains.

### Resuming After Handoff

When the Orchestrator receives a "Continue mission" request:

1. **Read `.context-continuation.md`** — this is the primary context source. Do NOT try to recover the previous conversation.
2. **Read ALL memory files** fresh — they contain everything important that was learned.
3. **Read `.current-mission.md`** — for the latest checkpoint.
4. **Resume from the phase indicated** in `.context-continuation.md` `Phase Starting` field.
5. **Do NOT re-run completed phases**. If analysis is done, skip to planning. If planning is done, skip to implementation. Trust the summaries.
6. **Reset the sequence counter** to 1 for the new session (but note the total in `.current-mission.md`).

### Agent Self-Reporting

Any agent can signal context pressure by including a `<context-pressure>` block in its `<team-response>`:

```xml
<team-response>
  ...
  <context-pressure>
    <level>high</level> <!-- low | medium | high | critical -->
    <reason>Large codebase analysis consumed significant context</reason>
  </context-pressure>
</team-response>
```

If the Orchestrator receives `<context-pressure>` with level `high` or `critical`, it MUST:
- Summarise all prior context aggressively before the next agent call
- Consider triggering a handoff if the mission has significant work remaining

### Continuation Envelope

When resuming, the first `<team-message>` MUST include a `<continuation>` block:

```xml
<team-message>
  <from>Orchestrator</from>
  <to>Coder</to>
  <mission-id>same-slug</mission-id>
  <sequence>1</sequence>
  <continuation>
    <previous-session-sequences>12</previous-session-sequences>
    <phase-resuming>implementation</phase-resuming>
    <completed-summary>Analysis + Planning complete. 3 of 7 files done.</completed-summary>
  </continuation>
  <memory-context>...</memory-context>
  <context>...</context>
  <task>...</task>
  <expected-output>...</expected-output>
</team-message>
```

## Error Recovery

- If any agent returns `status: blocked`, the Orchestrator should attempt to resolve the blocker or ask the user.
- If any agent returns `status: needs-more-info`, the Orchestrator should invoke the Analyser for additional research, then retry.
- If an agent fails entirely, the Orchestrator should log the failure and attempt the task itself as a fallback.
