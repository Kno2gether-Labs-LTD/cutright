# 0004 — Product name: Cutright, published by Viddescriptor

**Status:** Accepted (2026-08-17, owner chose the name)

## Context
The app was called **"Claude Video Editor"** (`com.avijitsarkar.claudevideoeditor`). "Claude" is
Anthropic's trademark; for a public release that reads as an official Anthropic product, and a
forced rename after the repo has stars and installs is far more expensive than one now. The owner
also wanted the name to connect to their AI-media brand, **viddescriptor.com**, so the two can
cross-promote.

## Decision
- **Product name: Cutright.** Verified before committing: free on npm, no product collision
  (`github.com/cutright` is a personal account belonging to someone with that surname),
  `cutright.app` / `.dev` / `.io` unregistered. Bundle id **`com.viddescriptor.cutright`**.
- **Viddescriptor is the publisher, not the product name** — "Cutright, by Viddescriptor" in the
  UI, the docs and the copyright line. Cross-promotion works in both directions without putting
  the brand in the product's trademark firing line.

## Why the brand name is not the product name
Viddescriptor contains the root **"descript"**, and **Descript** is the incumbent product in
*transcript-based video editing* — which is exactly this app's flagship feature. A parent brand in
AI media generation is a different category and a much weaker overlap; a transcript-first editor
called something-descript is a direct category collision and the most contestable name available
to us. Nominative brand attribution ("by Viddescriptor") carries none of that risk.

## Consequences
- The user-data directory moved (`~/Library/Application Support/Cutright`); main migrates the old
  folder on first launch so settings and recents survive.
- "Claude Code" now appears only as an accurate integration claim, per `NOTICE`.
- Renaming again is one commit: `productName`, `build.appId`, `<title>`, the header string.

## Still open
A trademark search on "Cutright" for software/SaaS before any registration or paid marketing.
It is also a surname, so distinctiveness is moderate — fine for a project name, worth a proper
search before it becomes a business.
