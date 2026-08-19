// Talking to an OpenAI-compatible endpoint.
//
// Deliberately the only shape supported, because it is also how every local runner speaks:
// Ollama, LM Studio, llama.cpp's server and vLLM all serve /v1/chat/completions. One client
// therefore covers "run a model on my own machine, offline, for free" and "use a hosted one"
// without shipping a model or a native inference runtime in a video editor.
//
// Nothing here is clever. It is a POST with a timeout, because the thing it must not do is hang
// an editor waiting on someone's laptop.
const LOCAL = [
  { name: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
  { name: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
  { name: 'llama.cpp', url: 'http://127.0.0.1:8080/v1' },
];

const trim = (u) => String(u || '').trim().replace(/\/+$/, '');

export function normaliseBase(url) {
  const u = trim(url);
  if (!u) return '';
  // People paste the chat endpoint, the root, or something in between. Accept all three.
  if (/\/chat\/completions$/.test(u)) return u.replace(/\/chat\/completions$/, '');
  if (/\/v1$/.test(u)) return u;
  return u + '/v1';
}

async function fetchWithTimeout(url, init, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

// Which local runners are actually up. Used to offer "you already have this" rather than making
// the user find out what a base URL is.
export async function detectLocal({ timeoutMs = 900 } = {}) {
  const found = [];
  await Promise.all(LOCAL.map(async (s) => {
    try {
      const r = await fetchWithTimeout(`${s.url}/models`, { method: 'GET' }, timeoutMs);
      if (!r.ok) return;
      const j = await r.json().catch(() => null);
      const models = (j?.data || []).map((m) => String(m.id)).filter(Boolean).slice(0, 40);
      found.push({ ...s, models });
    } catch { /* not running; that is the normal case */ }
  }));
  return found;
}

export async function listModels({ baseUrl, apiKey, timeoutMs = 6000 }) {
  const base = normaliseBase(baseUrl);
  if (!base) return { ok: false, error: 'no endpoint set' };
  try {
    const r = await fetchWithTimeout(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }, timeoutMs);
    if (!r.ok) return { ok: false, error: `the endpoint answered ${r.status}` };
    const j = await r.json();
    return { ok: true, models: (j?.data || []).map((m) => String(m.id)).filter(Boolean) };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'the endpoint did not answer' : String(e?.message || e) };
  }
}

export async function chat({ baseUrl, apiKey, model, system, user, timeoutMs = 90_000, temperature = 0.2 }) {
  const base = normaliseBase(baseUrl);
  if (!base) return { ok: false, error: 'no endpoint set' };
  if (!model) return { ok: false, error: 'no model chosen' };

  const body = {
    model,
    temperature,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    // Asked for, not relied on: plenty of compatible servers ignore it, which is why the parser
    // digs the JSON out of whatever comes back rather than trusting the format.
    response_format: { type: 'json_object' },
  };

  try {
    let r = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
    }, timeoutMs);

    // Some servers reject response_format outright. Retry once without it rather than telling
    // the user their endpoint is broken.
    if (r.status === 400) {
      delete body.response_format;
      r = await fetchWithTimeout(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
      }, timeoutMs);
    }

    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 200);
      const hint = r.status === 401 ? 'the key was refused'
        : r.status === 404 ? 'that model or path does not exist at this endpoint'
        : `the endpoint answered ${r.status}`;
      return { ok: false, error: detail ? `${hint}: ${detail}` : hint };
    }
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') return { ok: false, error: 'the endpoint returned no message' };
    return { ok: true, text, usage: j?.usage || null };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)}s` : String(e?.message || e) };
  }
}

export const _internals = { LOCAL };
