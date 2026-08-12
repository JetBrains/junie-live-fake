import { config } from './config.js';
import { pcmToWav } from './audio.js';

const auth = { Authorization: `Bearer ${config.openai.apiKey}` };

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Node's Buffer is typed over ArrayBufferLike, which Blob will not accept (it insists
 * on ArrayBuffer, since a SharedArrayBuffer-backed view would be unsound). Copying
 * into a fresh Uint8Array is a few hundred KB per utterance and sidesteps it.
 */
function toBlobPart(buf: Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy;
}

/** Transcribes one utterance. Returns '' when the model heard nothing usable. */
export async function transcribe(pcm: Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([toBlobPart(pcmToWav(pcm))], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', config.openai.transcribeModel);
  if (config.openai.transcribeLanguage) {
    form.append('language', config.openai.transcribeLanguage);
  }

  const res = await fetch(`${config.openai.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: auth,
    body: form,
  });
  if (!res.ok) {
    throw new Error(`transcription failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
}

export async function reply(history: ChatTurn[]): Promise<string> {
  const res = await fetch(`${config.openai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.openai.chatModel,
      messages: [{ role: 'system', content: config.openai.systemPrompt }, ...history],
    }),
  });
  if (!res.ok) {
    throw new Error(`chat failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return (json.choices?.[0]?.message?.content ?? '').trim();
}
