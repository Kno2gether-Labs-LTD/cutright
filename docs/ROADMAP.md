# Roadmap — what to build next

Produced 2026-08-17 by a research pass over the finished Phase 0/1 code, ranked by value to
a talking-head/tutorial creator. Items marked ✅ were built the same night; the rest are the
queue. Each entry states what it extends, so none of it is a rewrite.

> Ranking rationale: the top four are all gated on speed of iteration and on the app being
> able to edit a *tutorial* (talking head + screen recording), which the data model cannot
> represent yet. The novel ones (#6, #9) exist only because the edit is data.

1. **Transcript editing** ✅ **BUILT** *(branch `feat/transcript-edit`)* — delete words in a document view, the video cuts. Selection snaps into the gaps around the words, restore is exactly reversible, and a filler sweep is one click.
2. **Multi-format export (16:9 → 9:16 / 1:1) with subject tracking** — one recording, every aspect ratio; crop follows the speaker, captions re-layout per format. Extends the engine with a crop stage + per-format caption overrides. Use OpenCV YuNet or MediaPipe (Apache-2.0) as a separate process — **not** `opencv-python` wheels, which bundle a GPL-configured ffmpeg. Effort L.
3. **`clips[]` — a real B-roll / screen-recording track** — the biggest structural gap: `project.json` has exactly one video, so a tutorial (talking head + screen capture) cannot be edited, only decorated. One more composite stage in the engine, same `-itsoffset` + `enable='between(t,…)'` pattern as scenes/overlays. Effort M.
4. **Incremental render cache** — re-encode only the chunks that changed (hash of range + look + cues + scenes + overlays); a one-word caption fix goes from ~10 min to ~40 s on a 31-minute video. Gate behind a checksum-parity test against a full render. Effort L.
5. **The agent contract: `cutwright` CLI + MCP server + skill** — the embedded `claude` calls `cut_range` / `add_overlay` / `set_look` / `find_moments` instead of hand-writing JSON, and gets structured results (and schema validation) back. Effort M.
6. **Edit ledger — diff, review, revert what the agent did** — a history strip with semantic diffs ("removed 41 cuts, changed 3 captions") and Revert. The trust primitive for agentic editing; only possible because the edit is data. Effort S.
7. **Retake detection — "keep the last take"** — finds near-duplicate sentences (the flubbed restarts auto-cut can't see, because they contain no silence) and proposes dropping all but the final attempt. Pure n-gram work on `transcript.json`, reuses the auto-cut proposal panel. Effort S.
8. **Publish pack** — after export: SRT/VTT, YouTube chapters, description draft, thumbnail candidates, and a `shorts.json` of pull-quotes. The 45–90 minutes every creator spends after the edit. Effort M.
9. **`cutwright doctor` — lint the edit before you export** — "3 captions land on a cut seam", "scene 4 straddles a cut and will be silently dropped", "peak −0.2 dBTP will clip". Static analysis over `project.json` + `ffprobe`; also the CLI check the agent uses to verify its own work. Six always-right rules, not thirty heuristics. Effort S.
10. **Signed template packs + the pack store** — the paid layer. The plumbing exists (manifest, picker, user-templates dir that wins on id clash); what's missing is a catalogue, download + Ed25519 verification (`node:crypto`), and a licence field. **Commercial risk, not technical:** Apache-2.0 means anyone can delete the check — sell design work and updates, not DRM. Needs decisions on hosting, payments, an asset EULA that is explicitly *not* Apache-2.0, and **per-pack font licences** (bundling a commercial display font in a sold template is the likeliest legal mistake).

## Notes carried from the review
- A creator's real cost centres, in order: finding the bad bits (1, 7), reformatting for every platform (2), waiting for exports (4), and the post-edit publishing chores (8).
- Everything here reuses `make_remap()` — the single function that keeps captions, scenes, overlays and audio in sync through cuts. Anything that changes timing must go through it.
