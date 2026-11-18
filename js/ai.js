const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';

export function getGroqKey() { return localStorage.getItem('groq_api_key') || ''; }
export function setGroqKey(k) { localStorage.setItem('groq_api_key', k.trim()); }

export async function callGroq(messages) {
  const key = getGroqKey();
  if (!key) throw new Error('No Groq API key — add it in Settings.');
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 400 })
  });
  if (!res.ok) throw new Error(`Groq error ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}
