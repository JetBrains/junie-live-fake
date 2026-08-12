import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import * as brain from './brain.js';
import { config } from './config.js';
import * as db from './db.js';
import { Conversation } from './pipeline.js';

/** What attendee sends us. See docs/realtime_audio.md in the attendee repo. */
interface AttendeeMessage {
  bot_id?: string;
  trigger?: string;
  data?: { chunk?: string; sample_rate?: number; timestamp_ms?: number };
}

let connectionSeq = 0;

function jsonLog(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields }));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.url === '/ready') {
    db.ping().then(
      () => res.writeHead(200).end('ok'),
      (err) => res.writeHead(503).end(String(err)),
    );
    return;
  }
  // Make the bot say something without holding a websocket open. Handy from a script:
  //   curl -X POST https://agent-dev.labs.jb.gg/say -d '{"text":"привет"}'
  if (req.url === '/say' && req.method === 'POST') {
    readJson(req).then(
      (body) => {
        const { text, bot_id } = (body ?? {}) as { text?: string; bot_id?: string };
        if (!text) {
          res.writeHead(400).end('{"error":"text is required"}');
          return;
        }
        const spoken = brain.speakInto(bot_id, text);
        if (!spoken) {
          res.writeHead(404).end('{"error":"no such bot is connected"}');
          return;
        }
        res.writeHead(202).end('{"status":"speaking"}');
      },
      (err) => res.writeHead(400).end(JSON.stringify({ error: String(err) })),
    );
    return;
  }
  res.writeHead(404).end();
});

// Two websocket endpoints: attendee's audio stream, and external controllers. `ws`
// only filters one path per server, so routing happens in the upgrade handler.
const audioWss = new WebSocketServer({ noServer: true });
const controlWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === config.wsPath) {
    audioWss.handleUpgrade(req, socket, head, (ws) => audioWss.emit('connection', ws, req));
  } else if (path === config.brain.controlPath) {
    controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

controlWss.on('connection', (socket: WebSocket) => {
  const id = ++connectionSeq;
  brain.addController(socket, (msg, extra) =>
    jsonLog({ conn: id, message: msg, ...(extra === undefined ? {} : { extra }) }),
  );
});

audioWss.on('connection', (socket: WebSocket) => {
  const id = ++connectionSeq;
  const log = (msg: string, extra?: unknown) =>
    jsonLog({ conn: id, message: msg, ...(extra === undefined ? {} : { extra }) });

  log('attendee connected');

  let sessionId: number | null = null;
  let botId = 'unknown';
  let warnedSampleRate = false;
  // Set synchronously before the insert is awaited. Audio frames arrive faster than
  // the round trip to Postgres, so checking `sessionId === null` alone let several
  // frames each start their own INSERT and produced duplicate session rows.
  let sessionOpening = false;

  const conversation = new Conversation({
    log,
    sendAudio: (base64Pcm) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(
        JSON.stringify({
          trigger: 'realtime_audio.bot_output',
          data: { chunk: base64Pcm, sample_rate: config.sampleRate },
        }),
      );
    },
    onTurn: (role, text) => {
      if (sessionId === null) return;
      void db.recordTurn(sessionId, role, text).catch((e) => log('db write failed', String(e)));
    },
  });

  socket.on('message', (raw) => {
    let msg: AttendeeMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log('attendee sent non-JSON frame');
      return;
    }

    if (msg.bot_id && !sessionOpening) {
      sessionOpening = true;
      botId = msg.bot_id;
      conversation.attach(botId);
      db.openSession(botId).then(
        (sid) => {
          sessionId = sid;
          log('session opened', { botId, sessionId: sid });
        },
        (e) => log('could not open session row', String(e)),
      );
    }

    if (msg.trigger !== 'realtime_audio.mixed') return;
    const b64 = msg.data?.chunk;
    if (!b64) return;

    // A mismatch means both the transcription and the synthesized reply are pitch- and
    // speed-shifted, which is worth one loud complaint rather than silent nonsense.
    const rate = msg.data?.sample_rate;
    if (rate !== undefined && rate !== config.sampleRate && !warnedSampleRate) {
      warnedSampleRate = true;
      log('sample rate mismatch -- audio will be pitch-shifted', {
        fromAttendee: rate,
        expected: config.sampleRate,
      });
    }

    conversation.onAudio(Buffer.from(b64, 'base64'));
  });

  socket.on('close', () => {
    log('attendee disconnected', { botId });
    conversation.detach();
    if (sessionId !== null) void db.closeSession(sessionId, 'attendee disconnected').catch(() => {});
  });

  socket.on('error', (err) => log('attendee socket error', String(err)));
});

async function main(): Promise<void> {
  await db.initSchema();
  server.listen(config.port, () => {
    jsonLog({
      message: 'voice agent listening',
      port: config.port,
      audioPath: config.wsPath,
      controlPath: config.brain.controlPath,
      brainMode: config.brain.mode,
      sampleRate: config.sampleRate,
      outputFrameMs: config.outputFrameMs,
      transcribeModel: config.openai.transcribeModel,
      chatModel: config.openai.chatModel,
      ttsLanguage: config.googleTts.languageCode,
    });
  });
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    jsonLog({ message: `received ${sig}, shutting down` });
    audioWss.clients.forEach((c) => c.close());
    controlWss.clients.forEach((c) => c.close());
    server.close(() => void db.shutdown().finally(() => process.exit(0)));
  });
}

main().catch((err) => {
  jsonLog({ message: 'fatal', error: String(err) });
  process.exit(1);
});
