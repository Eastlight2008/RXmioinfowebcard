// Cloudflare Pages Function — A2S relay to self-hosted VPS
//
// Env vars (set in Cloudflare Pages dashboard):
//   A2S_RELAY_URL  = "http://YOUR_VPS_IP:3000"
//   A2S_SECRET     = "your-shared-secret"  (optional, must match VPS side)
//
// Single: GET  /api/a2s?ip=1.2.3.4&port=27015
// Batch:   GET  /api/a2s?servers=1.2.3.4:27015,5.6.7.8:27015
// Returns  { results: [{ip, port, players, max_players, server_name, error?}] }

const RELAY_URL = typeof A2S_RELAY_URL !== 'undefined' ? A2S_RELAY_URL : null;
const RELAY_KEY = typeof A2S_SECRET !== 'undefined' ? A2S_SECRET : null;
const CORS      = { 'Access-Control-Allow-Origin': '*' };

// ── Request Handler ────────────────────────────────────────────

export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (!RELAY_URL) {
    return Response.json(
      { error: 'A2S_RELAY_URL not configured' },
      { status: 500, headers: CORS },
    );
  }

  // Collect target servers
  const servers = [];

  const serversParam = url.searchParams.get('servers');
  if (serversParam) {
    // Batch mode: ?servers=ip:port,ip:port,...
    for (const pair of serversParam.split(',')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const [ip, portStr] = trimmed.split(':');
      const port = parseInt(portStr, 10);
      if (ip && port > 0) servers.push({ ip, port });
    }
  } else {
    // Single mode: ?ip=...&port=...
    const ip   = url.searchParams.get('ip');
    const port = parseInt(url.searchParams.get('port'), 10);
    if (ip && port > 0) servers.push({ ip, port });
  }

  if (servers.length === 0) {
    return Response.json(
      { error: 'No valid servers provided. Use ?ip=...&port=... or ?servers=ip:port,...' },
      { status: 400, headers: CORS },
    );
  }

  // ── Call VPS relay ──────────────────────────────────────────

  const fetchHeaders = { 'Content-Type': 'application/json' };
  if (RELAY_KEY) fetchHeaders['X-Relay-Key'] = RELAY_KEY;

  try {
    const vpsResp = await fetch(`${RELAY_URL}/a2s/batch`, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify({ servers }),
    });

    if (!vpsResp.ok) {
      const text = await vpsResp.text();
      return Response.json(
        { error: `VPS relay returned ${vpsResp.status}: ${text}` },
        { status: 502, headers: CORS },
      );
    }

    const data = await vpsResp.json();
    return Response.json(data, {
      headers: { ...CORS, 'Cache-Control': 'max-age=10' },
    });
  } catch (err) {
    return Response.json(
      { error: `VPS relay unreachable: ${err.message}` },
      { status: 502, headers: CORS },
    );
  }
}
