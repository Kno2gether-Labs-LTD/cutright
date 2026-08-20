# How the agent should change the edit

*A proposal, for review. Nothing here is built.*

You asked what I meant by "a CLI or MCP tool contract", and whether it is even possible given
that `project.json` was chosen deliberately — transcript first, a quick model call to pick cuts,
write it all to a file that Claude or any other agent can read and work on.

**That decision is right and none of this changes it.** The proposal is about one narrow thing:
not how the agent *reads* the edit, but how it *writes back*.

---

## The distinction

Today the agent does both halves the same way — with a text editor:

```
read  project.json     →  understand the edit          ← keep exactly as it is
write project.json     →  rewrite the whole file       ← this is the part in question
```

Reading a file is the cheapest, most flexible way for a model to understand an edit. It sees
everything at once, needs no vocabulary from us, and works with every agent that exists. Nothing
should change there.

Writing is different, because a write can be **wrong**, and right now nothing catches that until
much later.

## What goes wrong with whole-file writes

Four things, in rough order of how often they bite:

**1. It rewrites 35KB to change one number.** A caption is at the wrong height. The agent must
emit the entire project — every cut, every cue, every token — to move one value. That is slow,
expensive, and every field it re-emits is a field it can drop or subtly mangle. This is the most
common failure and the least dramatic: nobody notices until a render looks wrong.

**2. It races you.** The agent writes the whole file; you were editing a caption at the same
time; one of you wins. We have already been bitten by a version of this and there is a guard for
it now, but the guard *detects* the loss — it does not prevent it. A targeted change to one
element cannot lose an unrelated one.

**3. Nothing checks it at the moment it happens.** The agent can write a scene that straddles a
cut, a zoom centre of `1920` instead of `0.5`, a caption that ends before it starts. The
verifier catches all of these — afterwards, if someone runs it. The agent finds out it was wrong
minutes later, or not at all.

**4. The agent has to guess what it may do.** Today the vocabulary lives in prose in `CLAUDE.md`.
Prose is a good briefing and a poor contract: there is nothing to reject a call that misuses it.

## What a "tool contract" means concretely

Two shapes, same idea: a small set of named operations with defined inputs, which validate before
they touch the file.

### A CLI — a command the agent runs

```
cutright cut 12.4 14.0 --reason "abandoned take"
cutright caption move --from 5.0 --to 7.5 --height 640
cutright panel add --at 31.2 --type pills --headline "THREE THINGS"
cutright zoom add --at 44.0 --scale 1.35 --centre 0.62,0.40
```

Each returns structured JSON: what changed, what it re-timed as a consequence, and any warning.
An invalid call fails immediately with a message the agent can act on: *"a panel at 31.2s would
straddle the cut at 30.8–32.1 and be dropped at render time; place it clear of cuts."*

**Every agent you support can already do this.** Claude Code, Codex, Kimi Code and goose all run
shell commands — it is how they run `render_project.py` today. No protocol, no integration, no
per-agent work.

### An MCP server — typed tools the agent calls directly

The same operations, exposed over the protocol Claude Code (and some others) speak natively. The
agent sees a schema for each tool rather than a help page, so bad arguments are rejected before
they are sent, and there is no shell quoting to get wrong.

Strictly better ergonomics — for the agents that support it. Codex keeps MCP servers globally
and writes secrets into its config in plain text (see `docs/CODING_AGENTS.md`); goose calls them
extensions; Kimi has its own arrangement. So MCP means per-agent setup, and the least-common
denominator is still the shell.

## What I would actually do

**A CLI first, and MCP later as a thin wrapper over the same core.** One implementation, one set
of tests, and it works everywhere on day one.

**And I would not take the file away.** The agent keeps reading `project.json` directly, and
keeps being *allowed* to write it. The CLI becomes the recommended path — the one the brief
points at, the one that validates — not a wall. The moment we forbid direct writes we also
forbid everything we did not think of, and a general-purpose agent is valuable precisely because
it does things we did not anticipate.

So the contract is a **better path, not the only path**:

| | reads | writes |
|---|---|---|
| today | the file | the file |
| proposed | the file (unchanged) | the CLI, with the file still available |

## What it is worth, honestly

Some of what I originally claimed for this is now covered by the edit ledger
(`feat/edit-ledger`): every change is recorded and revertible per element, whoever made it. That
was the biggest argument and it is answered.

What the ledger does **not** do is stop a bad write happening. It records it faithfully and lets
you take it back. The contract's remaining value is:

- **rejection at the boundary**, with a reason the agent can use immediately
- **cheap targeted edits** instead of 35KB rewrites
- **no whole-file races** with the person editing
- **structured results**, so the agent knows what its change did without re-reading and diffing

That is real but it is no longer urgent. If you want an order, I would put a second video track
and timestamped notes ahead of it: those add things the editor cannot do at all, whereas this
makes something it already does safer and cheaper.

## What it would cost

- A `cutright` binary shipped with the app and on `PATH` for the agent's terminal.
- One core module holding each operation and its validation — most of which exists already in
  `engine/verify_project.py` as after-the-fact rules that would move to before-the-fact ones.
- Roughly a dozen operations to cover the current edit vocabulary.
- The brief changes from describing JSON shapes to listing commands, which makes it shorter.
- A new public surface to keep stable. This is the real cost: a CLI is a promise.

## The question for you

Not "CLI or MCP" — that answer is CLI first, MCP as a wrapper. The real question is whether
**writes should be validated at the boundary at all**, or whether recording and reverting them
(which now exists) is enough.

My view: worth doing, not next.
