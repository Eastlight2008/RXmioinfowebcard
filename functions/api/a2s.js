// Cloudflare Pages Function — A2S Source Server Query over TCP
// GET /api/a2s?ip=1.2.3.4&port=27015
// Returns { players, max_players, latency_ms } or { error }

import { connect } from 'cloudflare:sockets';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const ip = url.searchParams.get('ip');
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

    // Build A2S_INFO request
    // Header: 4 x 0xFF, Type: 0x54, Payload: "Source Engine Query\0"
    const queryStr = new TextEncoder().encode('Source Engine Query\0');
    const packet = new Uint8Array(5 + queryStr.length);
    packet[0] = 0xFF;
    packet[1] = 0xFF;
    packet[2] = 0xFF;
    packet[3] = 0xFF;
    packet[4] = 0x54;
    packet.set(queryStr, 5);

    await writer.write(packet);

    // Read response with timeout
    const timeoutMs = 4000;
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);

    const latency = Date.now() - start;
    const { value } = result;

    if (!value || value.length < 6) {
      return Response.json({ error: 'Empty response', latency_ms: latency });
    }

    // Verify header: 4 x 0xFF + 0x49 (A2S_INFO response)
    if (value[0] !== 0xFF || value[1] !== 0xFF || value[2] !== 0xFF || value[3] !== 0xFF || value[4] !== 0x49) {
      // Might be a challenge or split packet — return what we can
      return Response.json({ error: 'Unexpected response type', latency_ms: latency });
    }

    let pos = 5;

    // Read null-terminated string helper
    function readString(buf) {
      const end = buf.indexOf(0, pos);
      if (end === -1) return '';
      const str = new TextDecoder().decode(buf.slice(pos, end));
      pos = end + 1;
      return str;
    }

    // Protocol
    pos++; // skip protocol byte

    // Name
    readString(value);
    // Map
    readString(value);
    // Folder
    readString(value);
    // Game
    readString(value);

    // app_id (2 bytes little-endian)
    pos += 2;

    // Players, max_players, bots
    const players = pos < value.length ? value[pos++] : 0;
    const maxPlayers = pos < value.length ? value[pos++] : 0;
    const bots = pos < value.length ? value[pos++] : 0;

    return Response.json({
      players,
      max_players: maxPlayers,
      bots,
      latency_ms: latency,
    }, {
      headers: {
        'Cache-Control': 'public, max-age=20',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    const latency = Date.now() - start;
    return Response.json({
      error: err.message || 'Connection failed',
      latency_ms: latency,
    }, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } finally {
    try { socket?.close(); } catch (_) { /* ignore */ }
  }
}
