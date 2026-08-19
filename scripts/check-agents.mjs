#!/usr/bin/env node
// Choosing the coding agent.
//
// The claim this makes to the user is that Cutright is not tied to Claude Code: pick whatever
// you already have and the brief still reaches it. Two things have to hold for that to be true —
// detection must reflect what is actually on PATH (an agent listed as available that then fails
// with "command not found" is worse than one greyed out), and every agent must name a file the
// brief is actually written to, or it will start up knowing nothing about the project.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { AGENTS, DEFAULT_AGENT, byId, resolveBin, listAgents, launchCommand, kickoffPrompt } from '../electron/agents.mjs';

const root = mkdtempSync(join(tmpdir(), 'cutright-agents-'));
let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};

// A fake PATH holding exactly one agent, executable, plus one that is present but NOT executable.
const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho codex-cli 9.9.9\n'); chmodSync(join(bin, 'codex'), 0o755);
writeFileSync(join(bin, 'kimi'), 'not executable'); chmodSync(join(bin, 'kimi'), 0o644);
const env = { PATH: bin };

console.log('agents — which coding agent edits\n');

ok('finds an executable on PATH', resolveBin('codex', env) === join(bin, 'codex'));
ok('a file that is not executable does not count', resolveBin('kimi', env) === null,
   'a non-executable file would resolve here and then fail in the terminal');
ok('something absent is absent', resolveBin('definitely-not-here', env) === null);
ok('an empty PATH is not a crash', resolveBin('codex', { PATH: '' }) === null);

const listed = listAgents({ env, selected: 'codex', withVersions: false });
ok('only what is really installed is offered',
   listed.filter((a) => a.available).map((a) => a.id).join(',') === 'codex',
   'available: ' + listed.filter((a) => a.available).map((a) => a.id).join(','));
ok('the rest are listed, not hidden', listed.length === AGENTS.length,
   'the point is to show what installing one would buy');
ok('every unavailable agent says how to install it',
   listed.filter((a) => !a.available).every((a) => !!a.install));
ok('the selected one is marked', listed.filter((a) => a.selected).map((a) => a.id).join(',') === 'codex');

ok('Claude Code is the default', DEFAULT_AGENT === 'claude');
ok('an unknown id falls back to the default rather than throwing', byId('nope').id === 'claude');
ok('the launch line carries the agent\'s own flags',
   launchCommand('codex') === 'codex --dangerously-bypass-approvals-and-sandbox',
   launchCommand('codex'));
ok('goose is started without a bypass flag it does not have',
   launchCommand('goose') === 'goose session', launchCommand('goose'));

// The brief is written to CLAUDE.md, AGENTS.md and the selected agent's own filename. If an
// agent named some other file and nothing wrote it, that agent would start up blind.
const WRITTEN_ALWAYS = ['CLAUDE.md', 'AGENTS.md'];
ok('every agent names a doc file', AGENTS.every((a) => /\.md$/i.test(a.doc || '')));
ok('and the kickoff names the file that agent will have read',
   AGENTS.every((a) => kickoffPrompt(a.id).includes(a.doc)),
   AGENTS.map((a) => `${a.id}:${kickoffPrompt(a.id).includes(a.doc)}`).join(' '));
ok('the common two cover most agents without extra files',
   AGENTS.filter((a) => WRITTEN_ALWAYS.includes(a.doc)).length >= AGENTS.length - 1);

ok('no two agents share an id', new Set(AGENTS.map((a) => a.id)).size === AGENTS.length);
ok('every agent has somewhere to read about it', AGENTS.every((a) => /^https?:\/\//.test(a.url || '')));
ok('an agent whose MCP setup is manual explains itself',
   AGENTS.filter((a) => a.mcp === 'manual').every((a) => !!a.mcpNote),
   'a greyed-out capability with no explanation is just a dead end');

// Versions cost a process each; make sure asking for them actually reads the binary.
const withV = listAgents({ env, selected: 'codex' });
ok('a version is read from the installed binary',
   /9\.9\.9/.test(withV.find((a) => a.id === 'codex')?.version || ''),
   'got ' + withV.find((a) => a.id === 'codex')?.version);
ok('nothing is reported for what is not installed',
   withV.filter((a) => !a.available).every((a) => a.version === null));

rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
