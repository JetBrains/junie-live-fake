import { config } from './config.js';

const BYTES_PER_SAMPLE = 2; // 16-bit mono

export function msToBytes(ms: number): number {
  return Math.floor((config.sampleRate * ms) / 1000) * BYTES_PER_SAMPLE;
}

export function bytesToMs(bytes: number): number {
  return Math.round((bytes / BYTES_PER_SAMPLE / config.sampleRate) * 1000);
}

/** Mean absolute amplitude of a 16-bit LE mono buffer, 0..32767. */
export function frameEnergy(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += Math.abs(pcm.readInt16LE(i * BYTES_PER_SAMPLE));
  return sum / samples;
}

/**
 * Wraps raw PCM in a RIFF/WAVE container.
 *
 * The transcription endpoint takes a file, not a stream of samples, and refuses
 * headerless PCM — so every utterance gets a 44-byte header stuck on the front.
 */
export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = config.sampleRate * BYTES_PER_SAMPLE;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(config.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Google returns LINEAR16 wrapped in WAV; strip the header to get raw samples. */
export function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    // Walk the chunks rather than assuming 44 bytes: Google sometimes includes extra
    // metadata chunks before `data`.
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size % 2);
    }
  }
  return buf;
}

export function chunk(buf: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

export type VadEvent = { type: 'speech-start' } | { type: 'utterance'; pcm: Buffer };

/**
 * Energy-gated utterance detector.
 *
 * The Realtime API did this server-side; without it, endpointing has to happen here.
 * Deliberately simple: track whether recent audio is above a threshold, and close an
 * utterance once it has been quiet for `hangoverMs`.
 */
export class Vad {
  private speaking = false;
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private silentBytes = 0;
  private speechBytes = 0;

  constructor(private readonly emit: (ev: VadEvent) => void) {}

  push(pcm: Buffer): void {
    const isSpeech = frameEnergy(pcm) >= config.vad.threshold;

    if (!this.speaking) {
      if (!isSpeech) return; // drop silence before speech entirely
      this.speaking = true;
      this.silentBytes = 0;
      this.speechBytes = 0;
      this.emit({ type: 'speech-start' });
    }

    this.buffer.push(pcm);
    this.bufferedBytes += pcm.length;
    if (isSpeech) {
      this.speechBytes += pcm.length;
      this.silentBytes = 0;
    } else {
      this.silentBytes += pcm.length;
    }

    const done =
      this.silentBytes >= msToBytes(config.vad.hangoverMs) ||
      this.bufferedBytes >= msToBytes(config.vad.maxUtteranceMs);
    if (done) this.flush();
  }

  private flush(): void {
    const pcm = Buffer.concat(this.buffer);
    const speechMs = bytesToMs(this.speechBytes);
    this.reset();
    // Coughs, door slams and keyboard clacks all trip the threshold briefly; ignore
    // anything too short to be a sentence.
    if (speechMs >= config.vad.minSpeechMs) this.emit({ type: 'utterance', pcm });
  }

  reset(): void {
    this.speaking = false;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.silentBytes = 0;
    this.speechBytes = 0;
  }
}
