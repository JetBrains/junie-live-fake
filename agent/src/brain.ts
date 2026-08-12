import type { WebSocket } from 'ws';
import { config } from './config.js';

/**
 * Registry of external controllers — a CLI agent, a script, anything that connects to
 * CONTROL_PATH and decides what the bot should say.
 *
 * The controller is a websocket *client*, so it can run on a laptop without exposing
 * an inbound port. Protocol, both directions newline-free JSON frames:
 *
 *   agent -> controller  {"type":"hello","bot_id":...,"session_id":...}
 *   agent -> controller  {"type":"transcript","bot_id":...,"turn_id":N,"text":"..."}
 *   controller -> agent  {"type":"say","turn_id":N,"text":"..."}      answer a turn
 *   controller -> agent  {"type":"say","bot_id":"...","text":"..."}   speak unprompted
 *
 * `turn_id` ties an answer to the utterance that prompted it. Answers without one are
 * treated as unprompted speech.
 */

type Controller = { socket: WebSocket; id: number };

const controllers = new Map<number, Controller>();
let controllerSeq = 0;

/** Pending turns waiting on a controller answer, keyed by turn id. */
const pending = new Map<number, { resolve: (text: string) => void; timer: NodeJS.Timeout }>();
let turnSeq = 0;

/** Bots currently connected, so an unprompted `say` can be routed to one. */
type BotSink = { speak: (text: string) => Promise<void>; log: (m: string, e?: unknown) => void };
const bots = new Map<string, BotSink>();

export function registerBot(botId: string, sink: BotSink): void {
  bots.set(botId, sink);
}

export function unregisterBot(botId: string): void {
  bots.delete(botId);
}

export function controllerCount(): number {
  return controllers.size;
}

/**
 * Makes a bot speak without a prompting utterance. With no bot_id, picks the only
 * connected bot — the common case, since the CPU quota allows one at a time.
 * Returns false when there is nothing to speak into.
 */
export function speakInto(botId: string | undefined, text: string): boolean {
  const id = botId ?? [...bots.keys()][0];
  const sink = id ? bots.get(id) : undefined;
  if (!sink) return false;
  void sink.speak(text).catch((e) => sink.log('speech failed', String(e)));
  return true;
}

export function addController(socket: WebSocket, log: (m: string, e?: unknown) => void): void {
  const id = ++controllerSeq;
  controllers.set(id, { socket, id });
  log('controller connected', { controllers: controllers.size });

  for (const botId of bots.keys()) {
    send(socket, { type: 'hello', bot_id: botId });
  }

  socket.on('message', (raw) => {
    let msg: { type?: string; turn_id?: number; bot_id?: string; text?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log('controller sent non-JSON frame');
      return;
    }
    if (msg.type !== 'say' || typeof msg.text !== 'string') return;

    if (typeof msg.turn_id === 'number') {
      const waiting = pending.get(msg.turn_id);
      if (!waiting) {
        // Late answer: the turn already timed out. Speaking it now would be confusing.
        log('controller answered an unknown or expired turn', { turn_id: msg.turn_id });
        return;
      }
      clearTimeout(waiting.timer);
      pending.delete(msg.turn_id);
      waiting.resolve(msg.text);
      return;
    }

    // Unprompted: speak into a bot without being asked first.
    if (!speakInto(msg.bot_id, msg.text)) {
      log('controller wanted to speak but no such bot is connected', { bot_id: msg.bot_id });
    }
  });

  socket.on('close', () => {
    controllers.delete(id);
    log('controller disconnected', { controllers: controllers.size });
  });
  socket.on('error', (e) => log('controller socket error', String(e)));
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

export function broadcast(payload: unknown): void {
  for (const c of controllers.values()) send(c.socket, payload);
}

export function shouldUseExternal(): boolean {
  if (config.brain.mode === 'openai') return false;
  if (config.brain.mode === 'external') return true;
  return controllers.size > 0;
}

/**
 * Hands a transcript to the controllers and waits for one of them to answer.
 * Resolves to null on timeout or when nobody is listening.
 */
export function askControllers(botId: string, text: string): Promise<string | null> {
  if (controllers.size === 0) return Promise.resolve(null);
  const turnId = ++turnSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(turnId);
      resolve(null);
    }, config.brain.timeoutMs);
    pending.set(turnId, { resolve, timer });
    broadcast({ type: 'transcript', bot_id: botId, turn_id: turnId, text });
  });
}
