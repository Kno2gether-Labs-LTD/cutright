// The API key store has one rule that is easy to break and invisible when broken:
// asking WHETHER a key exists must never decrypt it.
//
//   node scripts/check-keys.mjs
//
// Decryption is a synchronous keychain read; on macOS the system raises an authorisation
// dialog whenever the app's signature has changed since the key was stored (i.e. after every
// update of an app that is not Developer ID signed). It opens behind the window and blocks
// main, so the app appears to freeze with nothing in the log. This test uses a safeStorage
// that raises if anything decrypts behind the app's back.
import { makeKeyStore } from '../electron/keys.mjs';

let decrypts = 0;
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s),
  decryptString: (b) => { decrypts++; return String(b).replace(/^enc:/, ''); },
};

const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
let saved = 0;
let settings = { keys: {} };
const keys = makeKeyStore({ safeStorage, getSettings: () => settings, save: () => saved++, env: {} });

// storing
const set = keys.set('openai', 'sk-secret');
if (!set.ok || !set.encrypted) fail('a key was not stored encrypted: ' + JSON.stringify(set));
if (!settings.keys.openai?.enc) fail('the stored key is not ciphertext');
if (String(settings.keys.openai.enc).includes('sk-secret')) fail('the key was written in the clear');
if (saved !== 1) fail('storing a key did not persist the settings');

// the rule
decrypts = 0;
if (keys.has('openai') !== true) fail('a stored key was not reported as present');
if (keys.known().openai !== true) fail('known() did not report the stored key');
if (decrypts !== 0) fail(`asking whether a key exists decrypted it ${decrypts} time(s) — this is the ` +
  'freeze: on macOS that is a blocking keychain dialog behind the window');

// using one may decrypt, and must return the real value
if (keys.get('openai') !== 'sk-secret') fail('the key did not round-trip');
if (decrypts !== 1) fail('get() should decrypt exactly once, saw ' + decrypts);

// settings replaced wholesale (main does this when it loads from disk) — the store must follow
settings = { keys: { elevenlabs: { plain: 'el-key' } } };
if (keys.has('openai')) fail('the store is holding a stale settings object');
if (keys.get('elevenlabs') !== 'el-key') fail('the store did not follow the replaced settings');

// environment fallback, and clearing
settings = { keys: {} };
const envKeys = makeKeyStore({ safeStorage, getSettings: () => settings, save: () => {}, env: { OPENAI_API_KEY: 'from-env' } });
if (!envKeys.has('openai') || envKeys.get('openai') !== 'from-env') fail('the environment fallback is broken');
keys.set('elevenlabs', 'x'); keys.set('elevenlabs', '');
if (settings.keys.elevenlabs) fail('clearing a key left it behind');

// an undecryptable key still counts as present, and never throws
settings = { keys: { openai: { enc: 'garbage' } } };
const angry = makeKeyStore({ safeStorage: { ...safeStorage, decryptString: () => { throw new Error('keychain denied'); } },
                             getSettings: () => settings, save: () => {}, env: {} });
if (!angry.has('openai')) fail('a key that cannot be decrypted was reported as absent');
if (angry.get('openai') !== '') fail('a failed decryption should come back empty, not throw');

console.log('✓ key store: presence never decrypts, use does, and it follows a replaced settings object');
