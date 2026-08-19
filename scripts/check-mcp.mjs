// Saving a key has to give the agent a working capability — and must never write the key down.
//
//   node scripts/check-mcp.mjs
//
// `.mcp.json` lives in the user's project folder: a folder people zip, sync and sometimes commit.
// So the entry refers to ${ELEVENLABS_API_KEY} and the value stays in the OS keychain, reaching
// Claude through the terminal's environment instead. The format is not invented here — it is what
// `claude mcp add-json --scope project` writes, and this check compares against that when the
// Claude CLI is present.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { register, unregister, isRegistered, status, SERVERS } = await import('../electron/mcp.mjs');
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const ws = mkdtempSync(join(tmpdir(), 'cutright-mcp-'));
const KEY = 'sk-this-must-never-be-written-down';

// ---- registering
const r = register(ws, 'elevenlabs');
if (!r.ok || !r.added) fail('registering did nothing: ' + JSON.stringify(r));
if (!isRegistered(ws, 'elevenlabs')) fail('it says it registered but does not see its own entry');

const raw = readFileSync(join(ws, '.mcp.json'), 'utf8');
if (raw.includes(KEY)) fail('THE KEY IS IN .mcp.json');
if (!raw.includes('${ELEVENLABS_API_KEY}')) fail('.mcp.json does not defer to the environment');
const doc = JSON.parse(raw);
const entry = doc.mcpServers?.elevenlabs;
if (entry?.command !== 'uvx' || !entry.args?.includes('elevenlabs-mcp'))
  fail('the entry does not run the ElevenLabs MCP server: ' + JSON.stringify(entry));

// ---- the shape is Claude Code's, not ours
const claude = spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout.trim();
if (claude) {
  const ref = mkdtempSync(join(tmpdir(), 'cutright-mcp-ref-'));
  const add = spawnSync('claude', ['mcp', 'add-json', '--scope', 'project', 'elevenlabs',
    JSON.stringify(SERVERS.elevenlabs.entry)], { cwd: ref, encoding: 'utf8' });
  if (add.status === 0 && existsSync(join(ref, '.mcp.json'))) {
    const theirs = JSON.parse(readFileSync(join(ref, '.mcp.json'), 'utf8'));
    if (JSON.stringify(theirs.mcpServers.elevenlabs) !== JSON.stringify(doc.mcpServers.elevenlabs))
      fail('our entry differs from what `claude mcp add-json` writes:\n  ours:   '
         + JSON.stringify(doc.mcpServers.elevenlabs) + '\n  theirs: '
         + JSON.stringify(theirs.mcpServers.elevenlabs));
    console.log('  matches what `claude mcp add-json --scope project` writes');
  }
  rmSync(ref, { recursive: true, force: true });
} else {
  console.log('  (claude CLI not installed — skipped the cross-check against its own output)');
}

// ---- pre-approval, so the user is asked once rather than twice
const approvals = join(ws, '.claude/settings.local.json');
if (!existsSync(approvals)) fail('our own server was not pre-approved');
if (!JSON.parse(readFileSync(approvals, 'utf8')).enabledMcpjsonServers?.includes('elevenlabs'))
  fail('the approval file does not name the server');

// ---- it must not trample anyone else's work
writeFileSync(join(ws, '.mcp.json'), JSON.stringify({
  mcpServers: { elevenlabs: { command: 'my-own-thing', args: [] }, other: { command: 'x' } } }, null, 2));
const again = register(ws, 'elevenlabs');
if (!again.unchanged) fail('it overwrote a hand-written entry for the same server');
const still = JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8'));
if (still.mcpServers.elevenlabs.command !== 'my-own-thing') fail("it changed someone else's entry anyway");
const gone = unregister(ws, 'elevenlabs');
if (!gone.unchanged) fail('it deleted an entry it did not write');
if (!JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8')).mcpServers.other)
  fail('it removed an unrelated server');

// ---- clearing the key takes ours away and leaves nothing behind
writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
register(ws, 'elevenlabs');
unregister(ws, 'elevenlabs');
if (existsSync(join(ws, '.mcp.json'))) {
  const left = JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8'));
  if (left.mcpServers?.elevenlabs) fail('clearing left the server behind');
}
if (existsSync(approvals) && JSON.parse(readFileSync(approvals, 'utf8')).enabledMcpjsonServers?.includes('elevenlabs'))
  fail('clearing left the approval behind');

// ---- the status the UI shows must be true
const st = status(ws, 'elevenlabs', { hasKey: false, which: () => null });
if (st.registered !== false) fail('status says registered after it was removed');
if (!st.install) fail('status does not say how to install the missing runner');
if (!st.tools?.includes('text_to_sound_effects')) fail('status does not say what the agent gains');

rmSync(ws, { recursive: true, force: true });
console.log('✓ mcp: the server is wired on save, the key stays out of the file, and nothing else is touched');
