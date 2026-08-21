# What I tested, and what happened

**Build tested:** `integration/all`, built and installed to `/Applications/Cutright.app`, signed by
*Developer ID Application: KNO2GETHER LABS LTD* and notarised through CI.
**Date:** 21 August 2026.

Everything below was run against the **installed app**, not just the source — so this is the same
thing you will open in the morning.

---

## The short version

| | |
|---|---|
| Automated tests inside the app | **73 run · 72 passed · 1 skipped · 0 failed** |
| Separate engineering checks | **20 run · 20 passed** (`npm run check:all`) |
| End-to-end on your real recording | **passed** — rendered, watched, measured |
| Bugs found while testing | **8**, all fixed (details at the bottom) |

The single skipped test needs a real human voice to transcribe. It cannot run without a
microphone recording, so it is skipped rather than faked.

---

## Part 1 — everything that already worked, re-checked

These are the features that existed before this week's work. I re-ran all of them on the new
build to make sure nothing new broke anything old.

| What it is | What it should do | Result |
|---|---|---|
| Opening a project | Pick a folder, land in the editor with the video loaded | ✅ |
| Home screen | Show recent projects, the feature list, and the brand panel | ✅ |
| Timeline | Every track lines up with its label, nothing is cut off, zoom and Fit work | ✅ |
| Playback | Play, pause, step a frame, jump to start and end | ✅ |
| Captions | Edit the words, highlight a word, change height, size and colour | ✅ |
| Caption defaults | Change them for the whole video at once | ✅ |
| Transcript editing | Delete a sentence in the text and the video cuts itself | ✅ |
| Auto-cut | Find dead air and filler words; every proposal is genuinely silent | ✅ |
| Cuts | Add one, drag it, delete it; the edit survives a save and reload | ✅ |
| Transitions | A cut can carry a fade, and it survives to the file | ✅ |
| Scenes / panels | Add one, edit it, see it on the track | ✅ |
| Overlays | Bring in a motion-graphics clip with transparency | ✅ |
| Templates | Both packs load with previews; applying one restyles captions, not content | ✅ |
| Zooms | Add a push-in; the centre is stored as a fraction, not pixels | ✅ |
| Zoom suggestions | Suggestions from a recording become real zooms when accepted | ✅ |
| Framing | Move the picture to a corner, to the side, back to full | ✅ |
| Recording | Sources listed, permissions reported, chunks written, pause stops the clock | ✅ |
| Transcription | Engines detected; API keys stored in the keychain and never shown again | ✅ |
| Prepare | One button transcribes, cuts, decides framing and applies the pack | ✅ |
| Check | Finds things a render would silently drop | ✅ |
| Sound | An ElevenLabs key wires the agent's sound tools without writing the key anywhere | ✅ |
| Agent hand-off | The brief reaches the agent; picking a template rewrites it | ✅ |
| Security | The app cannot read files outside your project; the page has no system access | ✅ |
| Onboarding | The tour, the guide and the environment check | ✅ |
| Switching projects | Opening another project actually reloads onto it | ✅ |

## Part 2 — everything added since

| What it is | What it should do | How I checked it | Result |
|---|---|---|---|
| **Live preview** | The player shows the edit, not the raw footage | Rendered a preview and compared it frame by frame against a full export | ✅ |
| Cuts while playing | Skip a cut instantly, without waiting for a render | Put the playhead inside a cut and watched where it landed | ✅ |
| Preview speed | Not rebuild everything each time | Two preview windows on your real recording: 27s then **11s** | ✅ |
| **Smarter cuts** | A model reads the transcript and suggests cuts | Ran it against a fake model — including a deliberately invented answer | ✅ |
| Cut safety | Never cut mid-word; never delete more than half a passage | Fed it bad answers on purpose and checked each was refused | ✅ |
| **Caption multi-select** | Select a run of captions and move them together | Shift-clicked three, pressed the arrow keys, checked the file | ✅ |
| **Protecting your edits** | The agent cannot quietly lose something you did by hand | Made an edit, let the "agent" delete it, checked it was caught and restored | ✅ |
| **Edit history** | See every change and take back just one | Made a two-part change, took back one half, confirmed the other survived | ✅ |
| **Timestamped notes** | Leave a note at a moment for the agent | Pressed N while playing; the note landed at the playhead and saved | ✅ |
| **Second video track** | Put b-roll or a screen recording over the main video | Rendered it and sampled the actual pixels, in and out of the box | ✅ |
| **Media directory** | Say where to get footage you are allowed to use | Checked no non-commercial source is ever offered as safe for paid work | ✅ |
| **Resizable panels** | Drag any panel; it remembers next time | Dragged, released, reset, and used the keyboard | ✅ |
| **Recording overlay** | Count-in over the screen, floating controls | A real recording driven end to end: Start, count-in, record, stop from the pill | ✅ |
| Recording produces a file | A take writes a video you can actually open | Checked the file on disk has pictures and a length, not just that it exists | ✅ 2.3 MB, 6s, 2560×1440 |
| Controls stay out of the shot | The pill must not appear in your recording | Recorded, then pulled a frame from that take and looked at the corner | ✅ not there |
| **Signing** | The app keeps one identity between updates | Signed two different builds and compared their identity | ✅ |
| **Recordings on Home** | A take you made shows up as a project, labelled | Opened Home and looked | ✅ |
| **Choosing the agent** | Use Claude, Codex, Kimi or goose | Listed what is installed and greyed out the rest | ✅ |
| **About panel** | Say which version you are running, and whether it is genuine | Opened it in the installed app and compared every line against what macOS reports | ✅ |
| **Check for updates** | Look for a newer release and say so — never install by itself | Asked the real GitHub feed; it correctly says there is no published release yet | ✅ |

## Part 3 — the real end-to-end test

Not a synthetic fixture: a copy of **your own 78-second recording** from 19 August, with camera
and screen. I added everything a real edit would carry, then rendered it and looked at the result.

| Step | Result |
|---|---|
| Added a cut, a zoom, a picture-in-picture clip, two framing moves, a note, a hand-edited caption | ✅ |
| Ran Check | 0 errors, 1 warning — correctly telling me a note was still open |
| Previewed 45–65s | 27 seconds |
| Previewed a second window | **11 seconds** (it reused the expensive part) |
| Full export | 63 seconds, **74.5s long** — exactly right after the two cuts |
| Layered export | Picture, captions with transparency, and the voice as separate files |
| Looked at four frames | Camera as a corner circle ✅ · back to full ✅ · the zoom ✅ · the picture-in-picture ✅ |
| Measured the sound | −14.6 LUFS against a −14 target ✅ *(this one failed first — see below)* |

---

## What broke while I was testing, and what I did

**1. Sound was too quiet on any video without music.**
Your export came out at −17.6 LUFS when the project asked for −14 — quiet enough to notice next
to other videos. Loudness levelling was only applied when a video had music or sound effects, so
a plain talking-head export was never levelled at all. It now always is. *Added a test that
measures a music-free export against its target.*

**2. Previewing a section that does not exist silently produced a file with sound and no picture.**
Asking for seconds 195–203 of an eight-second video "succeeded" and gave you a black screen with
audio. It now says so plainly, and a range that merely runs off the end is trimmed instead.

**3. Two tracks were unreachable.**
Adding the Clips and Notes tracks took the timeline to nine, and the panel was a fixed height with
no way to scroll — so the last two simply could not be seen. The timeline scrolls now, and starts
taller.

**4. The About panel said the app was checked by Apple when it was not.**
macOS reports an unchecked build as `source=Unnotarized Developer ID`, and the code looked for the
word "notarized" — which is *inside* "Unnotarized". So it reported a build macOS actively rejects
as approved. About is exactly where someone goes to ask "is this the real thing", so answering
that wrongly is worse than not answering. Now parsed properly, with a test built from the real
strings macOS prints.

**5. Recording produced nothing at all.** *(you found this one)*
Both of your attempts wrote a **zero-byte** file. To keep the recorder window out of the shot I
hid it — and a hidden window stops being drawn, so the browser engine stops handing over the
recorded data. Four seconds later the app's own "this capture is empty" check decided the
recording had failed and cancelled it. The recording did not fail; it was hidden to death. The
window now stays where it is, drawn at zero transparency and marked so macOS refuses to include
it in any recording.

**6. Two control pills, neither of which worked.**
Closing the old overlay and opening a new one raced each other: the old one's "I have closed"
message arrived *after* the new one existed, and cancelled out the app's only handle on it. The
result was a floating panel nothing could reach — and another one the next time. One panel is now
reused throughout, and it is destroyed when the recorder closes or the app quits.

**7. The controls appeared in every recording.**
Confirmed by pulling a frame out of a take and finding the pill in the corner. Both the controls
and the count-in are now excluded from screen capture, confirmed the same way.

**8. A warning that could never fire.**
The recorder is supposed to warn you when a build will lose your Screen Recording permission on
the next update. It used `require`, which does not exist in this part of the app — and the caller
caught the error and fell back to "everything is fine". So the warning had never once appeared,
and nothing said so. Fixed, and there is now a check that fails if any file makes that mistake
again.

---

## What I could not test, and why

| | Why |
|---|---|
| Recording from the **installed** app | Replacing the app dropped its Screen Recording permission. I proved recording works by running the same code from source, where permission is intact — but the copy in your Applications folder needs the permission granted again, and only you can do that |
| Suggesting cuts with a real AI model | Needs your endpoint and spends credits. The wiring and every safety rule are tested against a stand-in |
| Windows | The code paths exist; nothing has ever run there |
| Automatic updates | Deliberately not built yet — the app checks and tells you, it does not install. `docs/UPDATES.md` says what switching it on would involve |

---

## If you want to run it yourself

```bash
cd ~/video-editor-app
git checkout integration/all

npm test                 # everything: the 20 checks, then the 73 tests in the app
npm run check:all        # just the engineering checks
npm run smoke            # just the tests inside the app
npm run check:preview    # any single one — see package.json for the list
```

The app itself is already installed. **Grant Screen Recording once** before recording — Privacy &
Security → Screen Recording → Cutright. It will not ask again after that.
