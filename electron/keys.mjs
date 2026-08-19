// API keys: stored encrypted, unlocked only when one is about to be used.
//
// Two rules, both learned the hard way on a packaged build.
//
// 1. Asking WHETHER a key exists must never touch the keychain. On macOS every safeStorage
//    call — decryptString and isEncryptionAvailable alike — is a synchronous keychain read, and
//    the system holds it when the app's code signature has changed since the key was stored
//    (i.e. after every update of an app without a Developer ID certificate). Measured at 584
//    seconds with the whole app frozen and nothing in the log. Listing the transcription engines
//    used to trigger it, so opening a panel froze the app.
//
// 2. The calls that legitimately need the keychain must be bounded. They cannot be — safeStorage
//    is synchronous with no timeout — so `runOp` performs them in a separate process that the
//    caller can kill. That turns "the app is gone" into "the keychain did not answer", which is
//    something a user can act on.
//
// `runOp` is injected rather than imported so the rules can be tested against a keychain that
// hangs, throws, or counts its callers — see scripts/check-keys.mjs.
const ENV_VAR = { openai: 'OPENAI_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' };

export function makeKeyStore({ runOp, getSettings, save, env = process.env }) {
  // main replaces its settings object wholesale when it loads them from disk, so hold the
  // getter, never the object — a captured reference points at the pre-load defaults forever.
  const keys = () => (getSettings().keys ||= {});

  let keychain = null;                       // null = never asked, and asking is expensive
  const probe = async () => {
    if (keychain === null) {
      const r = await runOp('available');
      keychain = r.ok ? !!r.value : false;
    }
    return keychain;
  };

  const set = async (provider, value) => {
    if (!value) { delete keys()[provider]; save(); return { ok: true, cleared: true }; }
    const r = await runOp('encrypt', value);
    if (r.ok) {
      keychain = true;
      keys()[provider] = { enc: r.value };
      save();
      return { ok: true, encrypted: true };
    }
    // No keychain (rare, or the OS would not answer). Refuse rather than quietly writing a
    // secret to a plain file the user does not know about.
    keychain = false;
    return { ok: false, error: r.timedOut
      ? 'the system keychain did not respond, so the key was not saved'
      : `the key could not be encrypted: ${r.error}` };
  };

  // The only path allowed to unlock anything. Call it where a key is about to be used.
  const get = async (provider) => {
    const k = keys()[provider];
    if (!k) return env[ENV_VAR[provider]] || '';
    if (k.plain) return k.plain;                      // written by an older version
    const r = await runOp('decrypt', k.enc);
    return r.ok ? r.value : '';
  };

  const has = (provider) => !!(getSettings().keys?.[provider] || env[ENV_VAR[provider]]);
  const known = () => ({ openai: has('openai'), elevenlabs: has('elevenlabs'), keychain });

  return { set, get, has, known, probe };
}
