// The API key store has two rules that are easy to break and invisible when broken.
//
//   node scripts/check-keys.mjs
//
//   1. Asking whether a key EXISTS must never touch the keychain. On macOS every safeStorage
//      call is a synchronous keychain read, and the system holds it when the app's signature
//      has changed since the key was stored — measured at 584 seconds, whole app frozen.
//   2. The calls that legitimately need the keychain must be bounded, so a keychain that never
//      answers produces an error the user can act on rather than a dead application.
//
// Both are checked against a keychain that counts its callers, one that throws, and one that
// never answers at all.
import { makeKeyStore } from '../electron/keys.mjs';

const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
let calls = [];

const workingKeychain = async (op, data) => {
  calls.push(op);
  if (op === 'available') return { ok: true, value: true };
  if (op === 'encrypt') return { ok: true, value: Buffer.from('enc:' + data).toString('base64') };
  if (op === 'decrypt') return { ok: true, value: Buffer.from(data, 'base64').toString().replace(/^enc:/, '') };
  return { ok: false, error: 'unknown op' };
};

let saved = 0, settings = { keys: {} };
const keys = makeKeyStore({ runOp: workingKeychain, getSettings: () => settings, save: () => saved++, env: {} });

// ---- storing
const set = await keys.set('openai', 'sk-secret');
if (!set.ok || !set.encrypted) fail('a key was not stored encrypted: ' + JSON.stringify(set));
if (!settings.keys.openai?.enc) fail('the stored key is not ciphertext');
if (Buffer.from(settings.keys.openai.enc, 'base64').toString().includes('sk-secret') === false)
  fail('the ciphertext does not correspond to the key');
if (settings.keys.openai.enc.includes('sk-secret')) fail('the key was written in the clear');
if (saved !== 1) fail('storing a key did not persist the settings');

// ---- rule 1: presence never reaches the keychain
calls = [];
if (keys.has('openai') !== true) fail('a stored key was not reported as present');
if (keys.known().openai !== true) fail('known() did not report the stored key');
if (calls.length) fail(`asking whether a key exists hit the keychain (${calls.join(', ')}) — this is the ` +
  'freeze: on macOS that call can block the whole app for minutes');

// ---- using one may unlock, and must return the real value
if (await keys.get('openai') !== 'sk-secret') fail('the key did not round-trip');
if (!calls.includes('decrypt')) fail('get() never decrypted, so it cannot have read the real key');

// ---- the store must follow a settings object replaced wholesale (main does this on load)
settings = { keys: { elevenlabs: { plain: 'el-key' } } };
if (keys.has('openai')) fail('the store is holding a stale settings object');
if (await keys.get('elevenlabs') !== 'el-key') fail('the store did not follow the replaced settings');

// ---- environment fallback and clearing
settings = { keys: {} };
const envKeys = makeKeyStore({ runOp: workingKeychain, getSettings: () => settings, save: () => {},
                               env: { OPENAI_API_KEY: 'from-env' } });
if (!envKeys.has('openai') || await envKeys.get('openai') !== 'from-env') fail('the environment fallback is broken');
await keys.set('elevenlabs', 'x');
await keys.set('elevenlabs', '');
if (settings.keys.elevenlabs) fail('clearing a key left it behind');

// ---- rule 2: a keychain that never answers must not take the app with it
settings = { keys: {} };
const hung = makeKeyStore({
  runOp: async () => ({ ok: false, error: 'the system keychain did not respond', timedOut: true }),
  getSettings: () => settings, save: () => {}, env: {} });
const r = await hung.set('openai', 'sk-nope');
if (r.ok) fail('a key was reported saved when the keychain never answered');
if (!/did not respond/.test(r.error)) fail('the failure does not say what happened: ' + r.error);
if (settings.keys.openai) fail('a key was written even though it could not be encrypted');
if (JSON.stringify(settings).includes('sk-nope')) fail('the secret was written somewhere in the clear!');

// ---- a keychain that refuses: present, but unreadable, and never throwing
settings = { keys: { openai: { enc: 'garbage' } } };
const angry = makeKeyStore({ runOp: async () => ({ ok: false, error: 'keychain denied' }),
                             getSettings: () => settings, save: () => {}, env: {} });
if (!angry.has('openai')) fail('a key that cannot be decrypted was reported as absent');
if (await angry.get('openai') !== '') fail('a failed decryption should come back empty, not throw');

// ---- the availability probe is cached
calls = [];
const probed = makeKeyStore({ runOp: workingKeychain, getSettings: () => ({ keys: {} }), save: () => {}, env: {} });
if (probed.known().keychain !== null) fail('keychain state should be null until something asks');
if (await probed.probe() !== true || await probed.probe() !== true) fail('probe() did not report the keychain');
if (calls.filter((c) => c === 'available').length !== 1) fail('probe() is not cached: ' + calls.join(','));

console.log('✓ key store: presence never touches the keychain, use does, failures stay bounded and never leak the key');
