import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
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
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: config.wsPath });

wss.on('connection', (socket: WebSocket) => {
  const id = ++connectionSeq;
  const log = (msg: string, extra?: unknown) =>
    jsonLog({ conn: id, message: msg, ...(extra === undefined ? {} : { extra }) });

  log('attendee connected');

  let sessionId: number | null = null;
  let botId = 'unknown';
  let warnedSampleRate = false;

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

    if (msg.bot_id && sessionId === null) {
      botId = msg.bot_id;
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
      wsPath: config.wsPath,
      sampleRate: config.sampleRate,
      transcribeModel: config.openai.transcribeModel,
      chatModel: config.openai.chatModel,
      ttsLanguage: config.googleTts.languageCode,
    });
  });
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    jsonLog({ message: `received ${sig}, shutting down` });
    wss.clients.forEach((c) => c.close());
    server.close(() => void db.shutdown().finally(() => process.exit(0)));
  });
}

main().catch((err) => {
  jsonLog({ message: 'fatal', error: String(err) });
  process.exit(1);
});
