// API keys: stored encrypted, read back only when one is about to be used.
//
// This lives apart from main.js for one reason: the rule it enforces is easy to break by
// accident and impossible to see in a screenshot. On macOS, safeStorage decryption is a
// SYNCHRONOUS keychain read, and the system raises an authorisation dialog whenever the app's
// code signature has changed since the item was stored — which is every new build of an app
// that is not Developer ID signed. That dialog opens behind the window and blocks the main
// process, so the app just stops, with no error anywhere. It cost a hung test run to find.
//
// Therefore: asking WHETHER a key exists must never decrypt. Only asking for the key itself may.
//
// The same applies to safeStorage.isEncryptionAvailable(): on macOS that call READS the keychain
// too — it is what fetches the app's "Safe Storage" key — so it blocks in exactly the same way.
// Measured on a packaged build whose signature had changed since the key was stored: 584 seconds.
// Not a dialog anyone dismissed; the call simply did not return for nearly ten minutes, with the
// whole app frozen behind it.
//
// So the keychain is touched at exactly two moments, both of them things the user just asked for:
// saving a key, and using one. Never to draw a panel, and never at startup — a freeze at launch
// is still a freeze. The answer is cached once it is known.
//
// Injected rather than imported so the rules can be tested with a safeStorage that screams if
// it is touched — see scripts/check-keys.mjs.
const ENV_VAR = { openai: 'OPENAI_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' };

// `getSettings` is a getter, not the object: main replaces its settings wholesale when it loads
// them from disk, and a captured reference would quietly point at the pre-load defaults forever.
export function makeKeyStore({ safeStorage, getSettings, save, env = process.env }) {
  const settings = new Proxy({}, {
    get: (_t, k) => getSettings()[k],
    set: (_t, k, v) => { getSettings()[k] = v; return true; },
    has: (_t, k) => k in getSettings(),
    deleteProperty: (_t, k) => { delete getSettings()[k]; return true; },
  });

  const set = (provider, value) => {
    settings.keys = settings.keys || {};
    if (!value) { delete settings.keys[provider]; save(); return { ok: true, cleared: true }; }
    try {
      settings.keys[provider] = probe()
        ? { enc: safeStorage.encryptString(value).toString('base64') }
        : { plain: value };          // no keychain (rare): still works, clearly marked
      save();
      return { ok: true, encrypted: !!settings.keys[provider].enc };
    } catch (e) { return { ok: false, error: e.message }; }
  };

  // Cached: null until something actually needs the keychain, then true/false forever.
  let keychain = null;
  const probe = () => {
    if (keychain === null) {
      try { keychain = !!safeStorage.isEncryptionAvailable(); } catch { keychain = false; }
    }
    return keychain;
  };

  // The only function allowed to decrypt. Call it at the point of use, never to render a UI.
  const get = (provider) => {
    const k = settings.keys?.[provider];
    if (!k) return env[ENV_VAR[provider]] || '';
    if (k.plain) return k.plain;
    try { return safeStorage.decryptString(Buffer.from(k.enc, 'base64')); } catch { return ''; }
  };

  const has = (provider) => !!(settings.keys?.[provider] || env[ENV_VAR[provider]]);

  // `keychain` is null when the keychain has not been touched yet — "not asked", not "no".
  const known = () => ({ openai: has('openai'), elevenlabs: has('elevenlabs'), keychain });

  return { set, get, has, known, probe };
}
