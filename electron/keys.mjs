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
// Injected rather than imported so the rule can be tested with a safeStorage that screams if
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
      settings.keys[provider] = safeStorage.isEncryptionAvailable()
        ? { enc: safeStorage.encryptString(value).toString('base64') }
        : { plain: value };          // no keychain (rare): still works, clearly marked
      save();
      return { ok: true, encrypted: !!settings.keys[provider].enc };
    } catch (e) { return { ok: false, error: e.message }; }
  };

  // The only function allowed to decrypt. Call it at the point of use, never to render a UI.
  const get = (provider) => {
    const k = settings.keys?.[provider];
    if (!k) return env[ENV_VAR[provider]] || '';
    if (k.plain) return k.plain;
    try { return safeStorage.decryptString(Buffer.from(k.enc, 'base64')); } catch { return ''; }
  };

  const has = (provider) => !!(settings.keys?.[provider] || env[ENV_VAR[provider]]);

  const known = () => ({
    openai: has('openai'), elevenlabs: has('elevenlabs'),
    keychain: safeStorage.isEncryptionAvailable(),
  });

  return { set, get, has, known };
}
