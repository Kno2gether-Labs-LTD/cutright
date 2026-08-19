# Which coding agent does the editing

Cutright does not do the editing. It records what you want into `project.json`, mirrors that into
the markdown file a coding agent reads on its own, and then gets out of the way. The agent reads
the brief, edits `project.json`, and runs the render commands the brief hands it.

Nothing in that loop is specific to one vendor, so the agent is a choice. **Claude Code is the
default** because it is what this was built and tested against. Anything else you already have is
selectable from the **Agent** header in the terminal panel.

## What the app checks

The picker lists every agent it knows about and looks each binary up on `PATH` itself, rather
than shelling out to `which` — a shell alias or function would resolve there and then not exist
inside the terminal the app opens. What you have is selectable; what you do not is greyed out
with the command that would install it, because the point is to make it obvious what installing
one would buy, not to hide the option.

| Agent | Binary | Reads | How it starts |
|---|---|---|---|
| Claude Code | `claude` | `CLAUDE.md` | `claude --dangerously-skip-permissions` |
| Codex CLI | `codex` | `AGENTS.md` | `codex --dangerously-bypass-approvals-and-sandbox` |
| Kimi Code | `kimi` | `AGENTS.md` | `kimi --yolo` |
| goose | `goose` | `AGENTS.md` | `goose session` |
| Gemini CLI | `gemini` | `GEMINI.md` | `gemini --yolo` |
| opencode | `opencode` | `AGENTS.md` | `opencode` |
| Cursor CLI | `cursor-agent` | `AGENTS.md` | `cursor-agent --force` |

The first four were checked against the installed tool — the filename was read out of the binary
or the package, not assumed. Kimi Code has 23 references to `AGENTS.md` in its distribution;
goose lists `.goosehints` and `AGENTS.md` in its `CONTEXT_FILE_NAMES`. The rest come from their
published conventions and are marked **untested here** in the picker, which is the honest label:
the brief is written to `AGENTS.md` as well, so they will almost certainly work, but nobody has
run them through this app.

### About the bypass flags

Each agent is started in whatever mode lets it edit files without a prompt per change. The agent
is working inside your own project folder, and confirming every write makes the loop unusable.
This is a deliberate trade and the button says so; goose is the exception, because it takes its
approval behaviour from `GOOSE_MODE`, which is your setting to make rather than ours.

## Where the brief lands

`writeAgentFiles` writes the same body to `CLAUDE.md`, to `AGENTS.md`, and to whatever the
selected agent reads if it is neither of those. One source, so they cannot drift — there is a
test that fails if they do. Switching agents rewrites the files, so the one you picked always
finds the brief without being pointed at it.

## Sound, and why it is not automatic everywhere

Saving an ElevenLabs key wires the MCP server for Claude Code automatically: `.mcp.json` holds
`${ELEVENLABS_API_KEY}` and the value stays in the OS keychain, reaching the agent through the
environment of the terminal it runs in. The key never lands in the project folder.

That trick depends on the config format supporting an environment placeholder. Codex does not:
it keeps MCP servers in `~/.codex/config.toml`, globally rather than per project, and writes
`--env` values literally. Registering our server there would put your key on disk in plain text,
which is the one thing the key store exists to avoid — so Cutright shows you the command and the
trade-off and lets you decide, instead of doing it quietly:

```
codex mcp add elevenlabs --env ELEVENLABS_API_KEY=<your key> -- uvx elevenlabs-mcp
```

The other agents each keep MCP servers somewhere of their own; the picker names the file. None of
this affects editing — the brief, the templates, the render commands and `project.json` work the
same whichever agent you pick. It only affects whether the agent can generate music and effects
without leaving the app.
