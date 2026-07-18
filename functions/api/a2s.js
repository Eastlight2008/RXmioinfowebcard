// Cloudflare Pages Function — A2S Source Server Query over TCP
// GET /api/a2s?ip=1.2.3.4&port=27015
// Returns { players, max_players, latency_ms } or { error }
//
// Supports A2S challenge-response handshake (0x41) and split-packet reassembly.

import { connect } from 'cloudflare:sockets';

// ── A2S Protocol Helpers ───────────────────────────────────────

/**
 * Build A2S_INFO request packet.
 * If `challenge` (4-byte Uint8Array) is provided, it is appended after the payload.
 */
function buildQuery(challenge) {
  const payload = new TextEncoder().encode('Source Engine Query\x00');
  const extra = challenge ? 4 : 0;
  const packet = new Uint8Array(5 + payload.length + extra);
  packet[0] = 0xFF;
  packet[1] = 0xFF;
  packet[2] = 0xFF;
  packet[3] = 0xFF;
  packet[4] = 0x54; // A2S_INFO request
  packet.set(payload, 5);
  if (challenge) {
    packet.set(challenge, 5 + payload.length);
  }
  return packet;
}

/**
 * Read from a reader with a timeout. Rejects on timeout.
 */
function readWithTimeout(reader, timeoutMs) {
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

/**
 * Parse an A2S_INFO response buffer.
 * Returns { players, max_players, bots } or null if the response type is not 0x49 (Info).
 */
function parseInfo(buf) {
  if (buf.length < 6) return null;
  if (buf[0] !== 0xFF || buf[1] !== 0xFF || buf[2] !== 0xFF || buf[3] !== 0xFF) return null;

  // 0x49 = 'I' (Info response)
  if (buf[4] !== 0x49) return null;

  let pos = 6; // skip 4×FF + 0x49 + protocol byte

  function readString() {
    const end = buf.indexOf(0, pos);
    if (end === -1) {
      // no null terminator found — return rest as string
      const s = new TextDecoder().decode(buf.slice(pos));
      pos = buf.length;
      return s;
    }
    const s = new TextDecoder().decode(buf.slice(pos, end));
    pos = end + 1;
    return s;
  }

  readString(); // server name
  readString(); // map
  readString(); // folder
  readString(); // game

  if (pos + 2 > buf.length) return null;
  pos += 2; // app_id (int16 LE)

  const players    = pos < buf.length ? buf[pos++] : 0;
  const maxPlayers = pos < buf.length ? buf[pos++] : 0;
  const bots       = pos < buf.length ? buf[pos++] : 0;

  return { players, max_players: maxPlayers, bots };
}

// ── Request Handler ────────────────────────────────────────────

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const ip   = url.searchParams.get('ip');
  const port = parseInt(url.searchParams.get('port'), 10);

  if (!ip || !port) {
    return Response.json({ error: 'Missing ip or port' }, { status: 400 });
  }

  const start = Date.now();
  let socket;

  try {
    socket = connect({ hostname: ip, port: port });

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    // ── Send initial A2S_INFO query ──
    await writer.write(buildQuery());

    // ── Read first response (with 4s timeout) ──
    const A2S_TIMEOUT = 4000;
    let result;
    try {
      result = await readWithTimeout(reader, A2S_TIMEOUT);
    } catch (_e) {
      return Response.json(
        { error: 'A2S query timeout', latency_ms: Date.now() - start },
        { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }

    let value = result.value;
    let done  = result.done;

    // ── Challenge-response handshake (0x41 = 'A') ──
    if (
      value &&
      value.length >= 9 &&
      value[0] === 0xFF && value[1] === 0xFF &&
      value[2] === 0xFF && value[3] === 0xFF &&
      value[4] === 0x41
    ) {
      const challenge = value.slice(5, 9); // 4-byte challenge number

      // Re-send A2S_INFO with challenge
      await writer.write(buildQuery(challenge));

      try {
        result = await readWithTimeout(reader, A2S_TIMEOUT);
      } catch (_e) {
        return Response.json(
          { error: 'A2S challenge query timeout', latency_ms: Date.now() - start },
          { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } },
        );
      }

      value = result.value;
      done  = result.done;
    }

    // ── Try to read one more chunk (split-packet reassembly) ──
    if (value && !done) {
      try {
        const more = await readWithTimeout(reader, 250);
        if (more.value && more.value.length > 0) {
          const combined = new Uint8Array(value.length + more.value.length);
          combined.set(value, 0);
          combined.set(more.value, value.length);
          value = combined;
        }
      } catch (_e) {
        // No more data — use what we have
      }
    }

    const latency = Date.now() - start;

    if (!value || value.length < 6) {
      return Response.json(
        { error: 'Empty or too short response', latency_ms: latency },
        { headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }

    const info = parseInfo(value);

    if (!info) {
      const typeHex = value.length >= 5
        ? '0x' + value[4].toString(16).padStart(2, '0').toUpperCase()
        : 'unknown';
      return Response.json(
        { error: `Unexpected response type ${typeHex}, length ${value.length}`, latency_ms: latency },
        { headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }

    return Response.json(
      { ...info, latency_ms: latency },
      {
        headers: {
          'Cache-Control': 'public, max-age=20',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  } catch (err) {
    const latency = Date.now() - start;
    return Response.json(
      { error: err.message || 'Connection failed', latency_ms: latency },
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  } finally {
    try {
      socket?.close();
    } catch (_) {
      /* socket already closed */
    }
  }
}
