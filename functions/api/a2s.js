// Cloudflare Pages Function — Steam Game Server Query via Web API
// GET /api/a2s?ip=1.2.3.4&port=27015
// Returns { players, max_players, latency_ms } or { error }
//
// Uses Steam Web API IGameServersService/GetServerList — pure HTTPS, no raw sockets needed.
// Falls back to ISteamApps/GetServersAtAddress if the primary endpoint returns no results.

const STEAM_API_BASE = 'https://api.steampowered.com';
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

// ── Helpers ─────────────────────────────────────────────────────

function json(data, opts = {}) {
  return Response.json(data, { headers: { ...CORS_HEADERS, ...opts.headers }, ...opts });
}

// ── Request Handler ────────────────────────────────────────────

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const ip   = url.searchParams.get('ip');
  const port = parseInt(url.searchParams.get('port'), 10);

  if (!ip || !port) {
    return json({ error: 'Missing ip or port' }, { status: 400 });
  }

  const start = Date.now();
  let result = null;

  // ── Primary: IGameServersService/GetServerList ──
  // Filter queries Steam's master server for this exact IP:port.
  // Returns players / max_players / bots / map / name etc.
  try {
    const filter = `\\appid\\4000\\addr\\${ip}:${port}`;
    const apiUrl = `${STEAM_API_BASE}/IGameServersService/GetServerList/v1/?filter=${encodeURIComponent(filter)}&limit=1`;

    const resp = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });

    if (resp.ok) {
      const data = await resp.json();
      const servers = data?.response?.servers;
      if (servers && servers.length > 0) {
        result = servers[0];
      }
    }
    // If !resp.ok or no servers, fall through to fallback
  } catch (_) {
    // Primary failed — try fallback
  }

  // ── Fallback: ISteamApps/GetServersAtAddress ──
  // Broader query by IP only; may return servers on other ports.
  if (!result) {
    try {
      const apiUrl = `${STEAM_API_BASE}/ISteamApps/GetServersAtAddress/v1/?addr=${encodeURIComponent(ip)}`;
      const resp = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });

      if (resp.ok) {
        const data = await resp.json();
        const servers = data?.response?.servers;
        if (servers && servers.length > 0) {
          // Try to match by port
          result = servers.find(s => s.gameport === port) || servers[0];
        }
      }
    } catch (_) {
      // Both endpoints failed
    }
  }

  const latency = Date.now() - start;

  if (!result) {
    return json({ error: 'Server not found in Steam master list', latency_ms: latency });
  }

  return json(
    {
      players:     result.players ?? 0,
      max_players: result.max_players ?? 0,
      bots:        result.bots ?? 0,
      latency_ms:  latency,
    },
    { headers: { 'Cache-Control': 'public, max-age=20' } },
  );
}
