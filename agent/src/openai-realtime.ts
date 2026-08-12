import WebSocket from 'ws';
import { config } from './config.js';

export interface RealtimeHandlers {
  /** Base64 PCM16 audio the agent wants to speak. */
  onAudio: (base64Pcm: string) => void;
  /** A participant started speaking — used to cut off playback already in flight. */
  onSpeechStarted: () => void;
  onUserTranscript: (text: string) => void;
  onAgentTranscript: (text: string) => void;
  onClose: (reason: string) => void;
}

/**
 * Default session configuration. The Realtime API's shape has changed more than once,
 * so this is overridable wholesale via OPENAI_SESSION_UPDATE (raw JSON for the
 * `session` object) — a protocol change can then be fixed by editing a ConfigMap
 * instead of rebuilding the image.
 */
function sessionConfig(): unknown {
  const override = process.env.OPENAI_SESSION_UPDATE;
  if (override) return JSON.parse(override);

  const pcm = { type: 'audio/pcm', rate: config.sampleRate };
  return {
    type: 'realtime',
    instructions: config.openai.instructions,
    audio: {
      input: {
        format: pcm,
        // Server-side VAD: OpenAI decides when a turn ended, so we do not have to
        // do endpointing on the meeting audio ourselves.
        turn_detection: { type: 'server_vad' },
        transcription: { model: 'whisper-1' },
      },
      output: {
        format: pcm,
        voice: config.openai.voice,
      },
    },
  };
}

export class RealtimeSession {
  private ws: WebSocket;
  private ready = false;
  private queued: string[] = [];

  constructor(
    private readonly log: (msg: string, extra?: unknown) => void,
    private readonly handlers: RealtimeHandlers,
  ) {
    const url = `${config.openai.baseUrl}?model=${encodeURIComponent(config.openai.model)}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    });

    this.ws.on('open', () => {
      this.send({ type: 'session.update', session: sessionConfig() });
      this.ready = true;
      // Anything that arrived while the socket was still connecting.
      for (const chunk of this.queued) this.appendAudio(chunk);
      this.queued = [];
      this.log('openai realtime connected');
    });

    this.ws.on('message', (raw) => this.onMessage(raw.toString()));
    this.ws.on('error', (err) => this.log('openai realtime error', String(err)));
    this.ws.on('close', (code, reason) => {
      this.ready = false;
      this.handlers.onClose(`openai closed: ${code} ${reason.toString()}`);
    });
  }

  private onMessage(raw: string): void {
    let ev: { type?: string; [k: string]: unknown };
    try {
      ev = JSON.parse(raw);
    } catch {
      this.log('openai sent non-JSON frame');
      return;
    }
    const type = ev.type ?? '';

    // Surface protocol mismatches loudly rather than silently going mute: a rejected
    // session.update is the single most likely failure after an API revision.
    if (type === 'error') {
      this.log('openai error event', ev);
      return;
    }

    // Matched by suffix on purpose. The audio delta event has been renamed across
    // API versions (response.audio.delta, response.output_audio.delta, ...) and all
    // of them carry base64 in `delta`.
    if (type.endsWith('audio.delta') && typeof ev.delta === 'string') {
      this.handlers.onAudio(ev.delta);
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      this.handlers.onSpeechStarted();
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const t = ev.transcript;
      if (typeof t === 'string') this.handlers.onUserTranscript(t);
      return;
    }

    // Same suffix trick for the agent's own transcript.
    if (type.endsWith('audio_transcript.done')) {
      const t = ev.transcript;
      if (typeof t === 'string') this.handlers.onAgentTranscript(t);
      return;
    }

    if (type === 'session.created' || type === 'session.updated') {
      this.log(`openai ${type}`);
    }
  }

  /** Feed meeting audio in. Base64 PCM16 at config.sampleRate. */
  appendAudio(base64Pcm: string): void {
    if (!this.ready) {
      // Bounded so a stuck connection cannot grow this without limit.
      if (this.queued.length < 200) this.queued.push(base64Pcm);
      return;
    }
    this.send({ type: 'input_audio_buffer.append', audio: base64Pcm });
  }

  /** Drop audio the agent has queued to speak, so it stops talking over someone. */
  cancelResponse(): void {
    if (!this.ready) return;
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
  }

  private send(payload: unknown): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}
