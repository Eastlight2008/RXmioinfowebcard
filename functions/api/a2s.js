// Cloudflare Pages Function — Game Server Query via UApiPro
// GET /api/a2s?ip=1.2.3.4&port=27015
// Returns { players, max_players, latency_ms } or { error }

const UAPI_URL = 'https://uapis.cn/api/v1/game/steam/servers';
const APPID    = 4000;
const SEARCH   = 'Neo RXBreach';

const CORS = { 'Access-Control-Allow-Origin': '*' };

// In-memory cache (shared across requests within the same isolate)
let _cache = null;
let _cacheTs = 0;
const CACHE_MS = 30000; // 30s

async function getAllServers() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_MS) {
    return _cache;
  }

  const url = `${UAPI_URL}?appid=${APPID}&name=${encodeURIComponent(SEARCH)}&limit=30`;
  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error(`UApiPro HTTP ${resp.status}`);
  }

  const data = await resp.json();

  if (!data?.servers) {
    throw new Error('Unexpected UApiPro response');
  }

  _cache = data;
  _cacheTs = now;
  return data;
}

// ── Request Handler ────────────────────────────────────────────

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Health-check / debug endpoint
  if (url.pathname === '/api/a2s/debug') {
    try {
      const data = await getAllServers();
      return Response.json({
        ok: true,
        server_count: data.servers?.length ?? 0,
        sample: data.servers?.[0] ?? null,
      }, { headers: CORS });
    } catch (err) {
      return Response.json({ ok: false, error: err.message }, { status: 502, headers: CORS });
    }
  }

  const ip   = url.searchParams.get('ip');
  const port = parseInt(url.searchParams.get('port'), 10);

  if (!ip || !port) {
    return Response.json({ error: 'Missing ip or port' }, { status: 400, headers: CORS });
  }

  const start = Date.now();

  try {
    const data = await getAllServers();
    const server = data.servers.find(s => s.ip === ip && s.port === port);
    const latency = Date.now() - start;

    if (!server) {
      return Response.json({ error: 'Not found', latency_ms: latency }, { headers: { ...CORS, 'Cache-Control': 'max-age=10' } });
    }

    return Response.json({
      players:     server.players ?? 0,
      max_players: server.max_players ?? 0,
      latency_ms:  latency,
    }, { headers: { ...CORS, 'Cache-Control': 'max-age=20' } });
  } catch (err) {
    return Response.json(
      { error: err.message, latency_ms: Date.now() - start },
      { status: 502, headers: CORS },
    );
  }
}
