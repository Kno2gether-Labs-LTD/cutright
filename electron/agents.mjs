// Which coding agent does the editing.
//
// Cutright's UI is a briefing surface: it records what the user wants into project.json and
// mirrors it into the markdown files agents read from their working directory. Nothing about
// that is Claude-specific — so the app should not be either. Claude Code stays the default
// because it is what this was built and tested against, but any agent the user already has
// should be selectable, and the ones they do not have should be visible and greyed rather than
// hidden, so it is obvious what installing one would buy.
//
// The `doc` field is the part that has to be right: it is the file the agent reads on its own,
// without being told. Where it says "verified", the filename was read out of the installed
// binary or package on a machine that had it, not assumed:
//
//   claude  CLAUDE.md    — Claude Code's documented project file
//   codex   AGENTS.md    — verified: `codex mcp add` writes ~/.codex, and AGENTS.md is its
//                          project file (an AGENTS.md also ships in ~/.codex)
//   kimi    AGENTS.md    — verified: 23 references in @moonshot-ai/kimi-code/dist
//   goose   AGENTS.md    — verified: goose's CONTEXT_FILE_NAMES lists .goosehints and AGENTS.md
//
// The rest are listed from their published conventions and are marked so. If one turns out to be
// wrong the cost is small — the brief is written to AGENTS.md as well, which is now the common
// convention — but do not add an entry here without checking.
import { accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_AGENT = 'claude';

export const AGENTS = [
  {
    id: 'claude', name: 'Claude Code', vendor: 'Anthropic', bin: 'claude',
    doc: 'CLAUDE.md', verified: true,
    // Bypass mode: the agent works inside the user's own project folder, and a prompt per file
    // edit makes the loop unusable. The user starts it knowingly, from a button that says so.
    args: ['--dangerously-skip-permissions'],
    mcp: 'auto',
    install: 'npm install -g @anthropic-ai/claude-code',
    url: 'https://claude.com/claude-code',
  },
  {
    id: 'codex', name: 'Codex CLI', vendor: 'OpenAI', bin: 'codex',
    doc: 'AGENTS.md', verified: true,
    args: ['--dangerously-bypass-approvals-and-sandbox'],
    // Codex keeps MCP servers in ~/.codex/config.toml — global, not per project, and `--env`
    // values are written literally. Registering our ElevenLabs server there would put the key
    // on disk in plain text, which is the one thing the key store exists to avoid. So it is
    // offered as a command the user can run, with that trade-off stated, rather than done.
    mcp: 'manual',
    mcpCommand: 'codex mcp add elevenlabs --env ELEVENLABS_API_KEY=<your key> -- uvx elevenlabs-mcp',
    mcpNote: 'Codex stores MCP servers in ~/.codex/config.toml for every project, and writes the '
           + 'key into that file in plain text. Cutright will not do that for you.',
    install: 'npm install -g @openai/codex',
    url: 'https://developers.openai.com/codex/cli',
  },
  {
    id: 'kimi', name: 'Kimi Code', vendor: 'Moonshot AI', bin: 'kimi',
    doc: 'AGENTS.md', verified: true,
    args: ['--yolo'],
    mcp: 'manual',
    mcpNote: 'Kimi Code keeps its own config under .kimi — add the ElevenLabs MCP server there '
           + 'if you want it. The brief and project.json work either way.',
    install: 'npm install -g @moonshot-ai/kimi-code',
    url: 'https://github.com/MoonshotAI/kimi-code',
  },
  {
    id: 'goose', name: 'goose', vendor: 'Block', bin: 'goose',
    doc: 'AGENTS.md', verified: true,
    // goose has no bypass flag on `session`; it takes its approval behaviour from GOOSE_MODE,
    // which is the user's setting to make, not ours.
    args: ['session'],
    mcp: 'manual',
    mcpNote: 'goose calls MCP servers extensions — add one with `goose configure`.',
    install: 'brew install block-goose-cli',
    url: 'https://block.github.io/goose/',
  },
  {
    id: 'gemini', name: 'Gemini CLI', vendor: 'Google', bin: 'gemini',
    doc: 'GEMINI.md', verified: false,
    args: ['--yolo'],
    mcp: 'manual',
    mcpNote: 'Gemini CLI keeps MCP servers in .gemini/settings.json.',
    install: 'npm install -g @google/gemini-cli',
    url: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'opencode', name: 'opencode', vendor: 'SST', bin: 'opencode',
    doc: 'AGENTS.md', verified: false,
    args: [],
    mcp: 'manual',
    mcpNote: 'opencode keeps MCP servers in opencode.json.',
    install: 'npm install -g opencode-ai',
    url: 'https://opencode.ai',
  },
  {
    id: 'cursor', name: 'Cursor CLI', vendor: 'Anysphere', bin: 'cursor-agent',
    doc: 'AGENTS.md', verified: false,
    args: ['--force'],
    mcp: 'manual',
    mcpNote: 'Cursor keeps MCP servers in .cursor/mcp.json.',
    install: 'curl https://cursor.com/install -fsS | bash',
    url: 'https://docs.cursor.com/en/cli/overview',
  },
];

export const byId = (id) => AGENTS.find((a) => a.id === id) || AGENTS.find((a) => a.id === DEFAULT_AGENT);

// Look the binary up on PATH ourselves rather than shelling out to `which`: it is faster, it
// works the same on Windows, and it cannot be fooled by a shell alias or function, which would
// resolve here and then not exist for the pty.
export function resolveBin(bin, env = process.env) {
  const dirs = String(env.PATH || '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const full = join(d, bin + ext);
      try { accessSync(full, constants.X_OK); return full; } catch {}
    }
  }
  return null;
}

// Versions cost a process each, so they are read once and only for what is actually installed.
const versions = new Map();
function versionOf(bin, path) {
  if (versions.has(path)) return versions.get(path);
  let v = null;
  try {
    const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 4000 });
    const line = ((r.stdout || '') + (r.stderr || '')).split('\n').find((l) => /\d+\.\d+/.test(l));
    v = line ? line.trim().slice(0, 40) : null;
  } catch {}
  versions.set(path, v);
  return v;
}

export function listAgents({ env = process.env, selected = DEFAULT_AGENT, withVersions = true } = {}) {
  return AGENTS.map((a) => {
    const path = resolveBin(a.bin, env);
    return {
      id: a.id, name: a.name, vendor: a.vendor, bin: a.bin, doc: a.doc, url: a.url,
      install: a.install, mcp: a.mcp, mcpNote: a.mcpNote || null, mcpCommand: a.mcpCommand || null,
      verified: a.verified,
      available: !!path,
      path,
      version: path && withVersions ? versionOf(a.bin, path) : null,
      selected: a.id === selected,
    };
  });
}

// What to type into the terminal to start it. Kept here so the renderer never assembles a
// command line — it asks for the selected agent's and writes that.
export function launchCommand(id) {
  const a = byId(id);
  return [a.bin, ...(a.args || [])].join(' ');
}

// The first thing the agent is asked, naming the file it will actually have read.
export function kickoffPrompt(id) {
  const a = byId(id);
  return `Edit my video. Read ${a.doc} and project.json first.`;
}
