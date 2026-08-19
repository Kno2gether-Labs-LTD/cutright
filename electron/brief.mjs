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
      sceneEntrance: {
        note: 'A scene leaves a portrait card empty on the right and the picture slides into it over '
            + 'about half a second, with the panel fading up around it, then slides back out at the '
            + 'end. That is the default and needs nothing from you.',
        optOut: 'set "enter": "cut" on a scene to jump straight into the layout instead',
        pairsWith: 'capabilities.framing — the same machinery, if you want the picture moved without '
                 + 'a scene attached',
      },
      overlays,
      transitions: ['crossfade', 'dip', 'dipwhite', 'whip', 'wiperight', 'circle', 'smooth', 'pixel'],

      // Two video tracks, when the project came from a recording with a camera.
      tracks: {
        note: 'meta.tracks tells you whether this project has a separate camera. When it does, the '
            + 'SCREEN is the picture underneath and the CAMERA is what framing moves — so "to":"full" '
            + 'means the speaker fills the frame and the screen is hidden behind them.',
        useIt: 'Give the speaker the frame when the screen has nothing to say — an idea being '
             + 'explained rather than demonstrated — and hand it back when they start doing things '
             + 'again. The preprocess pass has already proposed these from measured screen activity; '
             + 'they are the frames[] entries with "source":"screen-static", and its reason is in '
             + '"why". Move them, drop them, add your own.',
      },

      // Where the picture sits in the frame, and what shape it is. This is what turns a
      // talking head into a presenter beside their own slide.
      framing: {
        shape: { start: '<seconds on the original timeline>', dur: '<how long the move takes, ~0.8s>',
                 to: 'full | side | corner',
                 shape: 'circle | rounded | rect (ignored when to=full)',
                 size: 'fraction of the frame WIDTH — 0.42 is a good side, 0.26 a good corner',
                 corner: 'tl | tr | bl | br (when to=corner)',
                 side: 'left | right (when to=side)',
                 margin: 'fraction of the width away from the edges, 0.04 by default',
                 backdrop: 'brand | blur | #rrggbb — what fills the space the picture left',
                 ease: 'inout | in | out | linear' },
        example: [
          { id: 'fr1', start: 18.0, dur: 0.8, to: 'side', side: 'right', size: 0.42,
            shape: 'rounded', backdrop: 'brand' },
          { id: 'fr2', start: 26.5, dur: 0.7, to: 'full' },
        ],
        howToUseIt: 'Move the speaker aside and the freed half is yours: put a scene or a rendered '
                  + 'overlay there for as long as the picture stays put, then bring it back to full '
                  + 'for the next beat. A corner circle is for when the screen recording matters more '
                  + 'than the face. Each entry is a MOVE, and the picture holds that state until the '
                  + 'next entry — so always write the one that returns it to full.',
        cost: 'the shape is drawn frame by frame during a move, so keep moves short (0.6–1.0s) and '
            + 'do not stack them closer than about two seconds',
      },

      // Camera moves. A push-in is data like everything else: no re-encode decision to make,
      // no plugin to call — add an entry and the engine animates it on export.
      zooms: {
        shape: { start: '<seconds on the original timeline>', dur: '<seconds>',
                 scale: '1.0 = untouched, 1.3 = a comfortable push-in, 1.6 = aggressive',
                 x: '0..1 across the frame (0.5 = centre)', y: '0..1 down the frame',
                 source: 'why it exists: manual | click | dwell | transcript' },
        example: { id: 'z1', start: 12.4, dur: 2.2, scale: 1.35, x: 0.62, y: 0.41, source: 'manual' },
        ramp: 'eases in and out over half a second at each end — do not stack two zooms closer than ~1.5s',
        suggestions: 'if this project came from a screen recording, `recording.zoomSuggestions[]` holds '
                   + 'candidates found from clicks, cursor dwell and the transcript. Copy the good ones '
                   + 'into `zooms[]`; leave the rest. They are suggestions, not edits.',
      },
      looks: ['none', 'film', 'warm', 'cool', 'teal-orange', 'bleach', 'noir', 'vhs'],
      audioPolish: ['none', 'voice', 'warm', 'podcast'],

      // How long a panel stays up is a consequence, not a setting.
      pacing: {
        note: 'A scene is up for as long as what it says is worth reading and the speaker is still '
            + 'on the subject: max(reading time, the transcript run from its start), held inside the '
            + "pack's minPanel..maxPanel. The preprocess pass sets scenes[].dur this way and records "
            + 'why in scenes[].durWhy.',
        rules: 'engine/pacing.py — the app and you use the same numbers',
        ifYouChangeIt: 'set dur yourself and delete durWhy, so nobody later thinks the pass chose it',
      },

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
      exportLayered: `python3 "${enginePath}/render_project.py" --project project.json --out FINAL.mp4 --layers layers`,
      transcribe: 'npx hyperframes transcribe <audio-or-video> --json -d .',
      verify: `python3 "${enginePath}/verify_project.py" --project project.json`,
      sfx: `python3 "${enginePath}/audio_agent.py" sfx --prompt "<sound>" --at <seconds> --dur 2 --project project.json`,
    },

    // The work happens in two passes, and this brief is written between them.
    passes: {
      one: 'structural — transcribe, cut, decide who has the frame, apply the pack, size the panels. '
         + 'Already done: it is what wrote the cuts, frames and durations you are reading.',
      two: 'craft — yours. Fix the captions, write the scenes, render and place motion graphics, add '
         + 'music and sound, set the final grade. Then check a range preview before you say it is done.',
      why: 'pass one is cheap and re-runnable, pass two is expensive. A wrong structural call is a '
         + 'JSON edit, not a re-render.',
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
        'add camera moves — push in on what matters, especially where the recording suggests it',
        'move the picture aside when a graphic deserves the frame, and bring it back afterwards',
        'set the final grade and audio polish',
      ],
      humanDecides: 'the final export, and anything that changes what the video says',
      handBack: 'When the user wants to review or finish elsewhere, export with --layers: the picture, '
              + 'the graphics and the captions come out as separate files (the last two with alpha) '
              + 'alongside the voice and every generated sound. Stacked in order they are the flat '
              + 'render, so what they review is what was made, not another interpretation of it.',
    },

    rules: [
      'project.json is the edit. Change it and the render changes. Never edit the video files directly.',
      'All timings are on the ORIGINAL timeline (the graded master). The engine re-times everything for cuts.',
      'A scene or overlay that straddles a cut is dropped at render time — place them clear of cuts.',
      'Zoom centres are normalised 0..1, never pixels, so the edit survives a change of resolution.',
      'Framing sizes and margins are fractions of the frame WIDTH, for the same reason.',
      'A framing move HOLDS until the next one. Write the move back to full, or it never comes back.',
      'Preview a range before exporting: a full export of a long video takes minutes.',
      'The user may be editing at the same time. Re-read project.json before writing, and keep your changes additive.',
      'Run the verifier before you say you are finished. It is the difference between "done" and "rendered, watched, and wrong".',
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
   The picture slides into the scene's card by itself, so leave half a second of breathing room
   before the beat you are illustrating.
5. **Motion graphics.** Where a moment deserves emphasis, render a preset and place it in
   \`overlays[]\` on the exact word (find the timing in \`transcript.json\`).
6. **Framing.** When a beat needs the screen or a graphic more than it needs a face, move the
   picture with \`frames[]\` — to the side (leaving the other half for a scene or overlay) or into
   a corner as a circle. Every move needs its partner bringing it back to \`full\`, or the picture
   stays where you left it for the rest of the video.
7. **Camera.** Add push-ins to \`zooms[]\` where the eye should go — a demo click, a number on
   screen, the line that lands. 1.25–1.4× for two seconds reads as intent; more reads as panic.
   If this project came from a screen recording, \`recording.zoomSuggestions[]\` already lists
   candidates from clicks, cursor dwell and the words. Copy across the ones that earn it.
8. **Finish.** Set \`grade.look\` and \`audio.polish\` if the brief asks for a mood.
9. **Check your work.** Run the verifier first — it finds in a second what a render finds in
   twenty minutes: a scene straddling a cut (silently dropped), two panels sharing the card, a
   framing move inside a cut, a zoom centre written in pixels, a missing overlay file.

   \`\`\`bash
   ${brief.commands.verify}
   \`\`\`

   Then render a range preview over two or three of your changes and confirm
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
  "zooms":    [ { "id":, "start":, "dur":, "scale": 1.3, "x": 0.5, "y": 0.5, "source": "manual" } ],
  "frames":   [ { "id":, "start":, "dur": 0.8, "to": "side|corner|full", "shape": "circle|rounded|rect",
                  "size": 0.42, "side": "right", "corner": "br", "margin": 0.04,
                  "backdrop": "brand|blur|#rrggbb" } ],
  "recording":{ "screen": "recording/screen.mp4", "cursor": "recording/cursor.json",
                "marks": [], "zoomSuggestions": [ /* same shape as zooms[], plus confidence */ ] },
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
