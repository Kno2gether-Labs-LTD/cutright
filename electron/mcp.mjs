// Wiring an MCP server into the project, so the agent gains a capability the moment the user
// saves a key.
//
// The rule that shapes all of this: THE KEY NEVER GOES IN THE FILE. `.mcp.json` sits in the
// user's project folder — a folder people zip up, sync, and occasionally commit — so it gets
// `${ELEVENLABS_API_KEY}`, which Claude Code expands from the environment at launch. The value
// itself stays in the OS keychain and is injected into the terminal Claude runs in.
//
// Everything here is additive and reversible: an entry we did not write is left alone, and
// clearing the key removes only our own.
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const MCP_FILE = '.mcp.json';
const APPROVALS = '.claude/settings.local.json';   // untracked, per the Claude Code convention

// Keyed by provider so a second integration is a table entry, not another module.
export const SERVERS = {
  elevenlabs: {
    name: 'elevenlabs',
    envVar: 'ELEVENLABS_API_KEY',
    // uvx ships with uv and fetches the server on first use — nothing to install by hand.
    entry: {
      command: 'uvx',
      args: ['elevenlabs-mcp'],
      env: { ELEVENLABS_API_KEY: '${ELEVENLABS_API_KEY}' },
    },
    needs: { bin: 'uvx', install: 'brew install uv', why: 'uvx runs the ElevenLabs MCP server' },
    gives: ['text_to_sound_effects', 'compose_music', 'create_composition_plan', 'text_to_speech'],
  },
};

function read(dir) {
  const path = join(dir, MCP_FILE);
  if (!existsSync(path)) return { path, doc: {}, existed: false };
  try { return { path, doc: JSON.parse(readFileSync(path, 'utf8')) || {}, existed: true }; }
  catch (e) { return { path, doc: {}, existed: true, broken: e.message }; }
}

export function isRegistered(dir, provider) {
  const s = SERVERS[provider];
  if (!s) return false;
  const { doc } = read(dir);
  return !!doc?.mcpServers?.[s.name];
}

export function register(dir, provider) {
  const s = SERVERS[provider];
  if (!s) return { ok: false, error: 'no MCP server known for ' + provider };
  const { path, doc, broken } = read(dir);
  if (broken) return { ok: false, error: `${MCP_FILE} is not valid JSON (${broken}) — fix or delete it` };

  const existing = doc.mcpServers?.[s.name];
  // Someone may have configured this themselves, with their own command or a real key in it.
  // Overwriting that would be rude, and would also silently move their key somewhere else.
  if (existing && JSON.stringify(existing) !== JSON.stringify(s.entry)) {
    return { ok: true, path, unchanged: true,
             note: `${MCP_FILE} already configures "${s.name}" differently — left as it is` };
  }

  doc.mcpServers = { ...(doc.mcpServers || {}), [s.name]: s.entry };
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  approve(dir, s.name, true);
  return { ok: true, path, added: s.name, tools: s.gives, envVar: s.envVar,
           // Claude Code asks before it will use a server defined by a project — a real
           // protection, since a project folder can come from anywhere. We pre-approve OUR entry
           // so there is one prompt (trusting the folder) rather than two, and say so in the UI.
           firstRun: 'Claude asks once, the first time it runs in this project, before using it' };
}

export function unregister(dir, provider) {
  const s = SERVERS[provider];
  if (!s) return { ok: false, error: 'no MCP server known for ' + provider };
  const { path, doc, existed, broken } = read(dir);
  if (!existed || broken) return { ok: true, unchanged: true };
  if (!doc.mcpServers?.[s.name]) return { ok: true, unchanged: true };

  // Only ever remove the entry we would have written. A hand-edited one is someone's own work.
  if (JSON.stringify(doc.mcpServers[s.name]) !== JSON.stringify(s.entry)) {
    return { ok: true, path, unchanged: true, note: `left "${s.name}" alone — it was not ours` };
  }
  approve(dir, s.name, false);
  delete doc.mcpServers[s.name];
  if (!Object.keys(doc.mcpServers).length) delete doc.mcpServers;
  // Do not leave "{}" behind in someone's project folder: if ours was the only thing in it, the
  // file has no reason to exist.
  if (!Object.keys(doc).length) { try { unlinkSync(path); } catch {} return { ok: true, path, removed: s.name, deletedFile: true }; }
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  return { ok: true, path, removed: s.name };
}

// Pre-approve (or un-approve) our own server, leaving any other entry alone. This only takes
// effect once the user trusts the folder, which is the point of the trust dialog — it is not a
// way around the prompt, just a way not to ask twice for the same decision.
function approve(dir, name, on) {
  const path = join(dir, APPROVALS);
  let doc = {};
  if (existsSync(path)) { try { doc = JSON.parse(readFileSync(path, 'utf8')) || {}; } catch { return; } }
  const list = new Set(doc.enabledMcpjsonServers || []);
  if (on) list.add(name); else list.delete(name);
  if (list.size) doc.enabledMcpjsonServers = [...list];
  else delete doc.enabledMcpjsonServers;
  if (!Object.keys(doc).length) { try { unlinkSync(path); } catch {} return; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}

// What the UI needs to tell the truth about the state of an integration.
export function status(dir, provider, { hasKey, which }) {
  const s = SERVERS[provider];
  if (!s) return { known: false };
  const binPath = s.needs?.bin ? which(s.needs.bin) : null;
  return {
    known: true,
    server: s.name,
    registered: isRegistered(dir, provider),
    hasKey: !!hasKey,
    tool: s.needs?.bin, toolPath: binPath || null,
    install: binPath ? null : s.needs?.install,
    why: s.needs?.why,
    tools: s.gives,
    envVar: s.envVar,
  };
}
