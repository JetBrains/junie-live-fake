import crypto from 'node:crypto';
import { config } from './config.js';
import { stripWavHeader } from './audio.js';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

const sa: ServiceAccount = JSON.parse(config.googleTts.serviceAccountJson);

let cached: { token: string; expiresAt: number } | null = null;

/**
 * Mints an access token with a self-signed JWT.
 *
 * Done by hand rather than with google-auth-library to keep the image dependency-free
 * beyond `pg` and `ws`. Cloud Text-to-Speech refuses API keys outright, so a real
 * principal is required.
 */
async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // Refresh a minute early so a token cannot expire mid-request.
  if (cached && cached.expiresAt > now + 60) return cached.token;

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .sign(sa.private_key)
    .toString('base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`google token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: now + json.expires_in };
  return json.access_token;
}

/** Synthesizes speech and returns raw PCM16 mono at config.sampleRate. */
export async function synthesize(text: string): Promise<Buffer> {
  const token = await accessToken();
  const voice: Record<string, unknown> = { languageCode: config.googleTts.languageCode };
  if (config.googleTts.voiceName) voice.name = config.googleTts.voiceName;

  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-goog-user-project': sa.project_id,
    },
    body: JSON.stringify({
      input: { text },
      voice,
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: config.sampleRate,
        speakingRate: config.googleTts.speakingRate,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`tts failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { audioContent: string };
  return stripWavHeader(Buffer.from(json.audioContent, 'base64'));
}
