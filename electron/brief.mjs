// The agent brief.
//
// Cutright's UI is a briefing surface. Picking a template, a look or a style records what
// the user wants into `project.json` under `brief` — the canonical, agent-agnostic payload —
// and mirrors it into CLAUDE.md and AGENTS.md beside it, because those are the files coding
// agents read automatically from their working directory.
//
// So the user clicks a few choices, then says "edit my video" in plain English, and the
// agent already knows the format, the house style, the presets it may render and the exact
// commands to run. The app does the mechanical part; the agent does the editing.
//
// Nothing here renders anything. It only records intent. Keep it that way: new integrations
// (MCP servers, image/video generation APIs) should add a `capabilities` entry describing
// how to call them, not code that calls them.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCENE_HELP = {
  pills: 'a headline plus 2–4 coloured pill labels — good for lists of things',
  checklist: 'a headline plus ticked items — good for requirements or steps',
  counter: 'a number that counts up, with a prefix/suffix — good for results and proof',
  stat: 'one big statement with a subtitle — good for a single punchy claim',
  strike: 'an old value struck through and replaced — good for myth-vs-truth beats',
};

export function buildBrief({ template, appVersion, templatesDir, enginePath }) {
  const t = template;
  const overlays = (t.overlays || []).map((o) => ({
    id: o.id,
    name: o.name,
    duration: o.duration || 4,
    variables: (o.vars || []).map((v) => ({ name: v.name, label: v.label, default: v.default })),
    render: [
      `npx hyperframes render "${join(t.dir || templatesDir, '')}"`,
      `--composition ${o.composition}`,
      `--format mov --fps 30 -q high`,
      `-o overlays/${o.id}-<name>.mov`,
      `--variables '${JSON.stringify(Object.fromEntries((o.vars || []).map((v) => [v.name, v.default ?? ''])))}'`,
    ].join(' '),
  }));

  return {
    generatedBy: `Cutright ${appVersion}`,
    generatedAt: new Date().toISOString(),
    note: 'Written by the app when the user makes a choice. Claude: this is the brief — read it before editing.',

    intent: '',            // the user can type what they want here (or say it to Claude)

    template: {
      id: t.id,
      name: t.name,
      engine: t.engine || 'hyperframes',
      description: t.description || '',
      dir: t.dir || join(templatesDir, t.id),
      tokens: t.tokens || {},
      captionDefaults: t.captions || {},
    },

    capabilities: {
      scenes: (t.scenes || []).map((type) => ({ type, use: SCENE_HELP[type] || '' })),
      overlays,
      transitions: ['crossfade', 'dip', 'dipwhite', 'whip', 'wiperight', 'circle', 'smooth', 'pixel'],
      looks: ['none', 'film', 'warm', 'cool', 'teal-orange', 'bleach', 'noir', 'vhs'],
      audioPolish: ['none', 'voice', 'warm', 'podcast'],

      // Generation is listed, never performed, here. Anything added later — an MCP server,
      // an image or video generation API — appends an entry in this shape: what it makes,
      // whether it is configured, and the exact way to call it.
      mediaGeneration: {
        audio: {
          provider: 'elevenlabs',
          makes: ['sfx', 'voiceover', 'music'],
          configured: !!(process.env.ELEVENLABS_API_KEY || existsSync(join(process.env.HOME || '', '.config/kno/elevenlabs.env'))),
          howTo: `python3 "${enginePath}/audio_agent.py" sfx --prompt "<sound>" --at <seconds> --dur 2 --project project.json`,
          then: 'the layer is added to audio.sfx[] and mixed on render',
        },
        image: { configured: false, note: 'not wired yet — when it is, this entry says how to call it' },
        video: { configured: false, note: 'not wired yet — when it is, this entry says how to call it' },
      },
    },

    commands: {
      previewRange: `python3 "${enginePath}/render_project.py" --project project.json --range <start> <end> --out preview.mp4`,
      export: `python3 "${enginePath}/render_project.py" --project project.json --out FINAL.mp4`,
      transcribe: 'npx hyperframes transcribe <audio-or-video> --json -d .',
      sfx: `python3 "${enginePath}/audio_agent.py" sfx --prompt "<sound>" --at <seconds> --dur 2 --project project.json`,
    },

    // What the app has already settled vs what is left for the agent. The user picks the
    // look by clicking; the craft is the agent's job.
    handoff: {
      appHasDone: [
        'built the graded master and the word-level transcript',
        'applied the template look (caption style, colours, fonts)',
        'recorded any cuts, overlays and look choices the user made by hand',
      ],
      agentShouldDo: [
        'tighten the edit — dead air, fillers, stutters, weak takes',
        'fix mis-heard captions and choose the emphasis word per line',
        'write the scene structure at the strongest beats',
        'render and place motion graphics on the exact words that deserve them',
        'set the final grade and audio polish',
      ],
      humanDecides: 'the final export, and anything that changes what the video says',
    },

    rules: [
      'project.json is the edit. Change it and the render changes. Never edit the video files directly.',
      'All timings are on the ORIGINAL timeline (the graded master). The engine re-times everything for cuts.',
      'A scene or overlay that straddles a cut is dropped at render time — place them clear of cuts.',
      'Preview a range before exporting: a full export of a long video takes minutes.',
      'The user may be editing at the same time. Re-read project.json before writing, and keep your changes additive.',
    ],
  };
}

export function agentDoc({ brief, project, appVersion }) {
  const t = brief.template;
  const scenes = brief.capabilities.scenes.map((s) => `- \`${s.type}\` — ${s.use}`).join('\n');
  const presets = brief.capabilities.overlays.map((o) =>
    `- **${o.name}** (\`${o.id}\`, ${o.duration}s) — variables: ${o.variables.map((v) => `\`${v.name}\``).join(', ') || 'none'}`).join('\n');
  const dur = project?.meta?.duration ? `${Math.floor(project.meta.duration / 60)}m ${Math.round(project.meta.duration % 60)}s` : 'unknown';

  return `# Editing this video with Cutright

You are an AI agent editing a **Cutright** project. This file is the standing brief;
\`project.json\` is the edit itself. (The same content is in \`CLAUDE.md\` and \`AGENTS.md\` so
whichever agent the user runs picks it up.)

When the user says **"edit my video"** (or similar), do the work described in *The job* below.

## The contract

\`project.json\` **is** the edit — captions, cuts, scenes, overlays, the grade and audio layers are
all data in it. The render is a pure function of that file. You change the file; the picture follows.
The app has the same file open and reloads when you save, so the user watches your work land.

- **Everything is timed on the ORIGINAL timeline** (\`graded_master.mp4\`). Never pre-compensate for
  cuts — the engine re-times captions, scenes, overlays and audio automatically.
- **Read before you write.** The user may be editing in the app at the same moment.
- **Preview, then export.** A full export of this ${dur} video takes minutes; a range preview takes seconds.

## What the user has chosen

Template: **${t.name}** (\`${t.id}\`) — ${t.description}
${brief.intent ? `\nTheir stated intent: **${brief.intent}**\n` : ''}
The full brief, including exact commands, is in \`project.json\` → \`brief\`. Read it.

### Scene types this template supports
${scenes || '- (none declared)'}

### Motion-graphics presets you may render
${presets || '- (none declared)'}

Render one with the command in \`brief.capabilities.overlays[].render\`, then add it to \`overlays[]\`:

\`\`\`json
{ "id": "lower3-relay", "src": "overlays/lower-third-relay.mov",
  "start": 38.5, "dur": 4, "x": 0, "y": 0 }
\`\`\`

You are not limited to the presets — you can author a new HyperFrames composition and render it
the same way. Match the template's tokens (${Object.entries(t.tokens || {}).filter(([, v]) => typeof v === 'string' && v.startsWith('#')).map(([k, v]) => `${k} ${v}`).join(', ') || 'see brief.template.tokens'}).

## The job — when asked to "edit my video"

1. **Read** \`project.json\` and \`transcript.json\`. Understand what the video actually says.
2. **Tighten.** Propose cuts for dead air, fillers and stutters — add them to \`cuts[]\`.
   Say how much you removed. Do not cut anything that carries meaning.
3. **Caption pass.** Fix mis-heard words in \`captions.cues[].tokens\`, especially names and
   product terms. Set the emphasis word (\`e: true\`) where the line lands.
4. **Structure.** Write \`scenes[]\` at the strongest beats — one per idea, 4–6 seconds,
   clear of any cut. Use the scene types above. Short headlines; the transcript has the detail.
5. **Motion graphics.** Where a moment deserves emphasis, render a preset and place it in
   \`overlays[]\` on the exact word (find the timing in \`transcript.json\`).
6. **Finish.** Set \`grade.look\` and \`audio.polish\` if the brief asks for a mood.
7. **Check your work.** Render a range preview over two or three of your changes and confirm
   they land where you intended. Then tell the user what you changed and what you left alone.

Do not run a full export unless the user asks — that is their call.

## Schema quick reference

\`\`\`jsonc
{
  "meta":     { "graded": "graded_master.mp4", "width":, "height":, "fps":, "duration":, "template": },
  "grade":    { "look": { "preset": "film", "grain": 0-40, "vignette": 0-1, "bloom": 0-1 } },
  "captions": { "defaults": { "fontsize":, "cy":, "color":, "highlight": },
                "cues": [ { "id":, "start":, "end":,
                            "tokens": [ { "t": "word", "e": false } ],
                            "overrides": { "cy":, "fontsize":, "highlight": } } ] },
  "scenes":   [ { "id":, "type": "pills|checklist|counter|stat|strike",
                  "start":, "dur":, "headline":, "items": [], "big":, "sub":, "target":, "old":, "new": } ],
  "overlays": [ { "id":, "src": "overlays/x.mov", "start":, "dur":, "x": 0, "y": 0, "enabled": true } ],
  "cuts":     [ { "start":, "end":, "transition": "crossfade", "tdur": 0.3 } ],
  "audio":    { "loudnessLUFS": -14, "polish": "voice", "music": [], "sfx": [] }
}
\`\`\`

## Commands

\`\`\`bash
# preview a range (seconds — use this constantly)
${brief.commands.previewRange}

# full export (minutes — only when asked)
${brief.commands.export}

# generate a sound effect and add it to the timeline
${brief.commands.sfx}
\`\`\`

---
*Generated by Cutright ${appVersion} when the user chose this template. Re-generated whenever they
change it — edit \`project.json\` → \`brief.intent\` to tell the agent what you are going for.*
`;
}

// Write both files. Idempotent: safe to call on every project open.
export function writeAgentFiles({ work, template, appVersion, templatesDir, enginePath }) {
  const projectFile = join(work, 'project.json');
  if (!existsSync(projectFile)) return { ok: false, error: 'no project.json' };
  const project = JSON.parse(readFileSync(projectFile, 'utf8'));

  const previous = project.brief || {};
  const brief = buildBrief({ template, appVersion, templatesDir, enginePath });
  brief.intent = previous.intent || '';           // never lose what the user typed
  project.brief = brief;
  writeFileSync(projectFile, JSON.stringify(project, null, 2));

  // Both filenames, same body: CLAUDE.md is what Claude Code auto-reads, AGENTS.md is the
  // neutral convention other agents follow. One source, so they cannot drift.
  const doc = agentDoc({ brief, project, appVersion });
  writeFileSync(join(work, 'CLAUDE.md'), doc);
  writeFileSync(join(work, 'AGENTS.md'), doc);
  return { ok: true, template: template.id, presets: brief.capabilities.overlays.length,
           sceneTypes: brief.capabilities.scenes.length };
}
