## What this changes

<!-- One or two sentences. What is different for the user after this lands? -->

## Why

<!-- The problem. Link an issue if there is one. -->

## How it was tested

- [ ] `npm run smoke` passes (say which project folder you ran it against)
- [ ] Added or updated an assertion that **fails without this change**
- [ ] Checked the packaged build if this touches paths, spawning or packaging (`npm run pack`)

<!-- Paste the summary line, e.g. editSuite: {"passed":43,"total":43,"failures":[]} -->

## Checklist

- [ ] No new dependency, or the PR explains why one is needed
- [ ] Long-running work runs in a utilityProcess with progress and a cancel path
- [ ] Nothing new exposed to the renderer beyond a named function in `preload.cjs`
- [ ] If a decision in `docs/decisions/` is being reversed, a new record explains why
