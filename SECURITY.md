# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting — **Security → Report a vulnerability** on this repository — or
email the maintainer at the address in `package.json`. Include what you did, what happened, and
the version (Cutright → About, or `package.json`). You will get an acknowledgement within a few
days; there is no bounty programme.

## What is in scope

Cutright is a local desktop application. The interesting boundary is the **renderer**, which is
sandboxed and must never gain access to the machine except through the named functions in
`electron/preload.cjs`. In scope:

- escaping the renderer sandbox, or reaching Node/`require`/`ipcRenderer` from page context
- reading or writing files **outside the open project folder** through the `cve://` scheme
- extracting a stored API key (they are encrypted with the OS keychain via `safeStorage` and
  must never be readable from the page)
- command injection through a project file, template manifest, transcript or file name — a
  malicious `project.json` should never be able to run a command
- anything that lets a downloaded **template pack** execute code outside the render it declares

## What is not in scope

- **The terminal runs your shell.** Cutright deliberately embeds a pty running your login shell
  and, if you use it, the `claude` CLI. Anything you can do in Terminal you can do there; that is
  the feature, not a vulnerability.
- **The agent edits your project.** An AI agent given your project folder can change it. Review
  what it does; that is why every change lands in `project.json` in plain text.
- Vulnerabilities in ffmpeg, Python or Node themselves — report those upstream. Cutright does not
  bundle ffmpeg (see `docs/decisions/0003-ffmpeg-not-bundled.md`); it invokes the one you installed.
- Missing macOS notarization on unsigned community builds. Official releases are signed.

## Hardening already in place

`contextIsolation: true` · `sandbox: true` · `nodeIntegration: false` · no remote code and no
`eval` (strict CSP) · navigation and `window.open` blocked · `cve://` refuses any path outside the
open project · `openExternal` accepts only the project's own domains · API keys encrypted at rest ·
every long-running job in its own process with a cancel path.

The test suite asserts several of these directly (`npm run smoke`), so a regression fails CI.
