import { bytesToMs, chunk, msToBytes, Vad } from './audio.js';
import * as brain from './brain.js';
import { config } from './config.js';
import { synthesize } from './google-tts.js';
import { reply, transcribe, type ChatTurn } from './openai.js';

export interface ConversationHooks {
  log: (msg: string, extra?: unknown) => void;
  /** Base64 PCM16 to play into the meeting. */
  sendAudio: (base64Pcm: string) => void;
  onTurn: (role: 'user' | 'agent', text: string) => void;
}

/**
 * One meeting's conversation: hear -> transcribe -> decide -> speak.
 *
 * "Decide" is either an external controller over CONTROL_PATH or OpenAI, per
 * BRAIN_MODE. This replaces a single OpenAI Realtime session, which would have done
 * endpointing, transcription, reasoning and speech in one socket; that model is not
 * available on this API key, so each step is a separate call and turn latency is
 * seconds rather than milliseconds.
 */
export class Conversation {
  private readonly vad: Vad;
  private readonly history: ChatTurn[] = [];
  /** While the bot is speaking, incoming audio is ignored (see onAudio). */
  private mutedUntil = 0;
  private busy = false;
  private botId = 'unknown';

  constructor(private readonly hooks: ConversationHooks) {
    this.vad = new Vad((ev) => {
      if (ev.type === 'speech-start') {
        this.hooks.log('speech started');
        return;
      }
      void this.handleUtterance(ev.pcm);
    });
  }

  /** Called once the bot id is known, so controllers can address this bot. */
  attach(botId: string): void {
    this.botId = botId;
    brain.registerBot(botId, {
      speak: (text) => this.sayAloud(text, 'agent'),
      log: this.hooks.log,
    });
  }

  detach(): void {
    if (this.botId !== 'unknown') brain.unregisterBot(this.botId);
  }

  onAudio(pcm: Buffer): void {
    // The mixed meeting stream can contain the bot's own voice, which would make it
    // transcribe itself and answer its own answer. Gating input while it speaks is the
    // simple fix; the cost is that it cannot be interrupted mid-sentence. Set
    // SELF_ECHO_GUARD_MS=0 to trade that back for barge-in.
    if (Date.now() < this.mutedUntil) return;
    this.vad.push(pcm);
  }

  private async handleUtterance(pcm: Buffer): Promise<void> {
    if (this.busy) {
      this.hooks.log('dropped an utterance, still answering the previous one', {
        ms: bytesToMs(pcm.length),
      });
      return;
    }
    this.busy = true;
    const started = Date.now();
    try {
      const heard = await transcribe(pcm);
      if (!heard) {
        this.hooks.log('transcription came back empty, ignoring');
        return;
      }
      this.hooks.log('heard', heard);
      this.hooks.onTurn('user', heard);
      this.history.push({ role: 'user', content: heard });
      this.trimHistory();

      const answer = await this.decide(heard);
      if (!answer) return;

      this.hooks.log('answering', answer);
      this.history.push({ role: 'assistant', content: answer });
      this.trimHistory();
      await this.sayAloud(answer, 'agent');
      this.hooks.log('turn complete', { ms: Date.now() - started });
    } catch (err) {
      // A failed turn must not kill the connection: the meeting is still going and the
      // next utterance may well work.
      this.hooks.log('turn failed', String(err));
    } finally {
      this.busy = false;
      // Drop whatever the VAD collected while we were busy, so the bot does not answer
      // a stale utterance.
      this.vad.reset();
    }
  }

  private async decide(heard: string): Promise<string | null> {
    if (brain.shouldUseExternal()) {
      const answer = await brain.askControllers(this.botId, heard);
      if (answer) return answer;
      if (config.brain.mode === 'external') {
        this.hooks.log('no controller answered and BRAIN_MODE=external, staying quiet');
        return null;
      }
      this.hooks.log('no controller answered, falling back to openai');
    }
    const answer = await reply(this.history);
    if (!answer) {
      this.hooks.log('model returned an empty answer, staying quiet');
      return null;
    }
    return answer;
  }

  /** Synthesizes and streams speech into the meeting. */
  private async sayAloud(text: string, role: 'agent'): Promise<void> {
    const pcm = await synthesize(text);
    const durationMs = bytesToMs(pcm.length);
    // Mute before the first frame goes out, not after the last: attendee starts playing
    // as soon as it receives audio.
    this.mutedUntil = Date.now() + durationMs + config.vad.selfEchoGuardMs;
    this.hooks.onTurn(role, text);

    for (const frame of chunk(pcm, msToBytes(config.outputFrameMs))) {
      this.hooks.sendAudio(frame.toString('base64'));
    }
    this.hooks.log('spoke', { ms: durationMs, frameMs: config.outputFrameMs });
  }

  private trimHistory(): void {
    const max = config.openai.maxHistoryTurns;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
  }
}
