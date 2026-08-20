# Signing

Two different problems wear the same word. They need different certificates and only one of them
needs Apple.

## 1. The app must stay the same app between builds

macOS decides whether an app is still "the same app" — for a Screen Recording grant, for the
camera, for the microphone — by matching the bundle against its **designated requirement**.

An ad-hoc signature's requirement is a hash of the build:

```
# designated => cdhash H"0fed2e3b62479709a111e5926e4cfa8c3fcd4ba2"
```

Change one byte, get a new hash, and macOS is looking at a stranger. That is why Screen Recording
had to be granted again after every rebuild: the tick in System Settings still referred to
yesterday's build.

Fixing it needs a certificate, but not Apple's. A self-signed one works, takes ten seconds and no
account:

```
npm run signing:local
```

Every build is then signed with it, and the requirement becomes stable:

```
designated => identifier "com.viddescriptor.cutright" and certificate root = H"3255…"
```

`npm run check:signing` measures exactly that. It signs two genuinely different bundles and
requires the requirement to come out identical, then runs both through the ad-hoc fallback and
requires that it **fails** the same test — without that second half the check would still pass if
the fix were removed, which is how a test quietly stops working.

You have to grant Screen Recording once more after switching, because the identity has changed
one final time. After that it sticks.

### What this does not fix

It was tempting to also credit this with fixing the keychain — earlier notes in this repo did.
That was wrong, and measuring it is what showed it. A cert-signed build and an ad-hoc build both
read the same stored secret, in the same ten seconds: `safeStorage`'s keychain item carries no
restrictive ACL, so the app's identity never gated it. The 584-second freeze that looked like
this was `isEncryptionAvailable()` blocking, and it is bounded by the out-of-process helper in
`electron/main.js`. Signing does not fix that and never did.

## 2. The app must run on someone else's Mac

This is the one that needs Apple, a paid Developer Program membership, and three minutes in a
browser that only you can do. Without it, everyone else gets a Gatekeeper warning no matter how
well the app is signed locally.

```
./scripts/setup-signing.sh csr                 # the request (already generated)
#   upload at developer.apple.com → Developer ID Application → download the .cer
./scripts/setup-signing.sh import ~/Downloads/developerID_application.cer
export APPLE_ID="…" APPLE_TEAM_ID="…" APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
npm run dist:signed
```

That signs with hardened runtime, notarizes the app (`build/notarize.cjs`), staples it, then
notarizes and staples the **DMG** as well (`build/staple-dmg.cjs`). The second half matters: the
DMG is assembled after the app is notarized, so without it the disk image itself carries no
ticket and Gatekeeper has to ask Apple over the network when someone opens it — a spinner on a
poor connection, a failure on none.

Both hooks are no-ops without the Apple credentials, so an unsigned local build keeps working.

## Signing in CI

`.github/workflows/release.yml` builds what ships when a `v*` tag is pushed. It signs with the
same certificate, from GitHub's encrypted secrets — nothing about signing lives in the repo.

Set it up once, from the Mac that has the certificate:

```
./scripts/ci-signing-secrets.sh
```

That exports the certificate and its private key as a password-protected `.p12`, uploads it and a
freshly generated passphrase as encrypted Actions secrets, and deletes the local copy. macOS will
ask permission to export the key — that prompt is the security boundary, which is why the script
is yours to run rather than something automation does quietly.

| Secret | What it is |
|---|---|
| `MACOS_CERTIFICATE_P12` | the certificate and private key, base64 |
| `MACOS_CERTIFICATE_PASSWORD` | the passphrase protecting it |
| `APPLE_SIGN_IDENTITY` | the identity name to sign as |
| `APPLE_TEAM_ID` | the team, for notarization |
| `APPLE_ID` | your Apple ID, for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | from appleid.apple.com, for notarization |

The workflow hands `CSC_LINK` and `CSC_KEY_PASSWORD` to electron-builder, which imports them into
a keychain of its own making and discards it afterwards — so nothing shells out to `security` and
no certificate is left on the runner. Secrets are masked in logs by GitHub, and none of them are
echoed.

Two deliberate behaviours:

- **Without the secrets it still builds**, unsigned, with a warning. A fork or a pull request must
  not fail because it cannot see your certificate.
- **With them, it asserts.** If the secrets were present but the app did not come out
  Developer ID signed, the job fails rather than publishing something that claims to be signed and
  is not. Notarization missing is a warning, not a failure, so a signed build can still ship while
  the app-specific password is being set up.

The release is attached as a **draft**. Publishing is a decision, and a person makes it.

## Which one do I have?

```
security find-identity -v -p codesigning
codesign -d -r- /Applications/Cutright.app | grep designated
```

`cdhash` means neither — every build is a new app. `certificate root` means the local
certificate. `certificate leaf` with an Apple authority means Developer ID.

The app tells you too: the recorder warns before you grant anything if the build it is running
from will not keep the grant.
