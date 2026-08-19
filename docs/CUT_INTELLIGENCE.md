# Deciding what to cut

Two passes, and they are different kinds of claim.

## The waveform (always on)

`silencedetect` measures the audio and reports where nobody is speaking. Word timings from the
transcript then guarantee no proposal ever clips speech, and filler words and stutters are found
from the words themselves. This is a **measurement**: it can be wrong about whether a pause
should go, but it is never wrong about whether the room was quiet.

## The words (optional)

Silence detection cannot know that the first take of a sentence was abandoned, that a
thirty-second aside went nowhere, or that "let me just find that window… no, hang on" is dead
weight even though you never stopped talking. Those are the cuts that make a tutorial watchable,
and they need someone to read the transcript.

Turn on **read the transcript** in the auto-cut panel and a language model does. Long recordings
are sent in passages of about 2000 tokens, so the length of the video is not a limit; a passage
that fails is skipped and the rest still run.

### What it is not allowed to do

The dangerous failure here is not a crash, it is a confident wrong answer — cutting the good take
instead of the abandoned one. So the model's reply is treated as a claim to be checked against
the transcript we already have:

- It answers with **segment numbers**, never timestamps, so every boundary it can name is one
  that already exists. No cut can clip a word in half.
- A segment number it was never shown is discarded.
- A passage where it wants to remove more than half the speech is thrown away whole, and the
  panel says why. One bad passage does not take the transcript with it.
- Suggestions never overwrite the acoustic ones. Where they overlap, the measurement wins.
- Every suggestion arrives **unticked**, with its reason, whatever confidence it claimed. A
  silence is a measurement; a reading is an opinion, and opinions get looked at first.
- Nothing is applied. It lands in the same review panel as everything else.

`scripts/check-cutplan.mjs` proves each of those against a fake endpoint, so the suite needs no
key and no network.

## Choosing a model

Only the **OpenAI-compatible** shape is supported: an endpoint, a model name, and optionally a
key. That is not a shortcut — it is what makes running the model on your own machine the same
setting as using a hosted one.

| If you want | Point it at |
|---|---|
| Local, offline, free | Ollama — `http://127.0.0.1:11434/v1` |
| Local, with a UI | LM Studio — `http://127.0.0.1:1234/v1` |
| Local, bare | llama.cpp server — `http://127.0.0.1:8080/v1` |
| Hosted | any provider's `/v1` base URL, plus a key |

The panel looks for the first three and offers them if they are already running, so the common
local case is one click and nothing leaves the machine.

### Why Cutright does not ship a model

Small quantized models certainly exist that would fit in an installer — Qwen 0.5B, Llama 3.2 1B,
Gemma 1B and similar, around 350MB–800MB as Q4 GGUF, with `node-llama-cpp` or a bundled
`llama.cpp` server to run them. We are not doing that, for three reasons:

1. **Judgement, not fluency.** Deciding that one take was abandoned and the next was the keeper
   is a reasoning task over long context. Models at that size are not reliable at it, and an
   unreliable cut suggestion is worse than none — the acoustic pass at least never lies about the
   waveform.
2. **Weight.** Several hundred megabytes to gigabytes in the installer, for a feature many people
   will not use, in an app that already asks you to install ffmpeg.
3. **Stability.** It would mean another native module compiled against Electron's ABI. This is a
   video editor; the bar for adding one of those is high.

Anyone who wants a local model can run a *good* one — 7B and up — through Ollama in a couple of
minutes, and gets a better result than anything we could reasonably bundle. If that calculus
changes, the endpoint is already the only integration point, so bundling a runtime later would
not change anything above this line.
