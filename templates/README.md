# Templates

A **template** is a look you can apply to a project, plus the motion-graphics presets that
come with it. It is data + composition files — no app code — so new templates can ship
separately (bundled, downloaded, or written by hand).

```
templates/<id>/
  template.json        the manifest (below)
  preview.png          card thumbnail for the picker
  overlays/*.html      HyperFrames compositions (engine: hyperframes)
  remotion/            a Remotion project (engine: remotion)
```

## Manifest

```jsonc
{
  "id": "coral-ink-bone",
  "name": "Coral / Ink / Bone",
  "version": "1.0.0",
  "engine": "hyperframes",        // which renderer draws this template's overlays
  "sceneEngine": "pillow",        // which renderer draws split-screen scenes (pillow = built in)
  "captions": { ... },            // merged into project.captions.defaults on apply
  "tokens": { ... },              // colours/fonts the compositions read as variables
  "overlays": [                   // insertable motion-graphics presets
    { "id": "lower-third", "name": "Lower third", "composition": "overlays/lower-third.html",
      "duration": 4,
      "vars": [ { "name": "tag", "label": "Tag", "default": "SELF-HOSTED" } ] }
  ]
}
```

Applying a template writes `meta.template` + `captions.defaults` into `project.json`.
Inserting a preset renders the composition **with your variables** (HyperFrames
`--variables`, Remotion `--props`) to an alpha clip in `overlays/` and adds it to the
project's `overlays[]` — from then on it is a normal timeline clip.

## Where templates are found

1. bundled with the app (`templates/` in the app resources)
2. `~/Library/Application Support/Cutright/templates` (user-installed)

Both are scanned at startup; the user directory wins on an id clash.
