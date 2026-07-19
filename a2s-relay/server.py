"""
A2S UDP Relay Server
=====================
Responds to HTTP requests by performing Source Engine A2S_INFO UDP queries
against game servers. Supports single and batch queries with in-memory caching.

Run:  gunicorn -w 4 -b 0.0.0.0:3000 server:app
"""

import os
import socket
import struct
import time
import threading
from flask import Flask, request, jsonify

app = Flask(__name__)

# ── CORS ──────────────────────────────────────────────────────

@app.after_request
def _add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Relay-Key"
    return response


# ── Config ────────────────────────────────────────────────────
RELAY_KEY = os.environ.get("A2S_RELAY_KEY", "")  # shared secret; empty = no auth

# ── In-memory cache ────────────────────────────────────────────
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
CACHE_TTL = 5  # seconds


# ── A2S_INFO protocol ──────────────────────────────────────────

def a2s_info(ip: str, port: int, timeout: float = 3.0) -> dict:
    """Send A2S_INFO request via UDP and parse the response.

    Returns {"players": int, "max_players": int, "server_name": str}
    or {"error": str} on failure.
    """
    # A2S_INFO payload: 4-byte header (0xFF 0xFF 0xFF 0xFF) + 'T' + "Source Engine Query" + 0x00
    request = b'\xff\xff\xff\xffTSource Engine Query\x00'

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(request, (ip, port))
        data, _ = sock.recvfrom(4096)
    except socket.timeout:
        return {"error": "timeout"}
    except OSError as exc:
        return {"error": f"socket error: {exc}"}
    finally:
        sock.close()

    # Parse response header
    if len(data) < 6 or data[:4] != b'\xff\xff\xff\xff':
        return {"error": "bad response header"}

    header_byte = data[4]
    if header_byte == 0x41:  # Challenge response
        # Server wants a challenge number — resend with the challenge appended
        challenge = data[5:9]
        request2 = request + challenge
        sock2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock2.settimeout(timeout)
        try:
            sock2.sendto(request2, (ip, port))
            data, _ = sock2.recvfrom(4096)
        except socket.timeout:
            sock2.close()
            return {"error": "timeout on challenge response"}
        except OSError as exc:
            sock2.close()
            return {"error": f"socket error (challenge): {exc}"}
        finally:
            sock2.close()

        if len(data) < 6 or data[:5] != b'\xff\xff\xff\xff\x49':
            return {"error": "bad challenge response"}
    elif header_byte != 0x49:  # 'I' — normal info response
        return {"error": f"unexpected header byte: 0x{header_byte:02x}"}

    # Skip 4-byte header + 0x49 + protocol + null-terminated name
    # Layout: header(4) + type(1) + protocol(1) + name(null-term) + map(null-term)
    #         + folder(null-term) + game(null-term) + id(2) + players(1) + max_players(1)
    #         + bots(1) + server_type(1) + os(1) + password(1) + vac(1)
    offset = 6  # skip 4-byte header + 0x49 + protocol byte
    try:
        # server_name (null-terminated)
        end = data.index(0, offset)
        server_name = data[offset:end].decode('utf-8', errors='replace')
        offset = end + 1

        # map
        end = data.index(0, offset)
        offset = end + 1

        # folder
        end = data.index(0, offset)
        offset = end + 1

        # game
        end = data.index(0, offset)
        offset = end + 1

        # id (2 bytes)
        offset += 2

        # players (1), max_players (1), bots (1)
        if offset + 3 > len(data):
            return {"error": "response too short for player counts"}

        players = data[offset]
        max_players = data[offset + 1]

        return {
            "players": players,
            "max_players": max_players,
            "server_name": server_name,
        }
    except (ValueError, IndexError) as exc:
        return {"error": f"parse error: {exc}"}


# ── Auth helper ──────────────────────────────────────────────

def _check_key():
    if not RELAY_KEY:
        return  # no auth required
    sent = request.headers.get("X-Relay-Key", "")
    if sent != RELAY_KEY:
        return _err("Unauthorized", 401)


# ── Routes ─────────────────────────────────────────────────────

@app.route("/a2s", methods=["GET"])
def handle_single():
    if err := _check_key(): return err
    ip = request.args.get("ip")
    port_str = request.args.get("port")
    if not ip or not port_str:
        return _err("Missing ip or port", 400)
    try:
        port = int(port_str)
    except ValueError:
        return _err("Invalid port", 400)

    result = _cached_query(ip, port)
    return jsonify(result)


@app.route("/a2s/batch", methods=["POST"])
def handle_batch():
    if err := _check_key(): return err
    body = request.get_json(silent=True)
    if not body or not isinstance(body.get("servers"), list):
        return _err("Expected JSON body with 'servers' array", 400)

    results = []
    for entry in body["servers"]:
        ip = entry.get("ip")
        port = entry.get("port")
        if not ip or not port:
            results.append({"ip": ip, "port": port, "error": "missing ip or port"})
            continue
        try:
            port = int(port)
        except (ValueError, TypeError):
            results.append({"ip": ip, "port": port, "error": "invalid port"})
            continue
        r = _cached_query(ip, port)
        r["ip"] = ip
        r["port"] = port
        results.append(r)

    return jsonify({"results": results})


@app.route("/a2s/batch", methods=["GET"])
def handle_batch_get():
    """Browser-friendly GET batch: ?servers=ip:port,ip:port,..."""
    raw = request.args.get("servers", "")
    if not raw:
        return _err("Missing 'servers' query param", 400)

    results = []
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair:
            continue
        parts = pair.split(":")
        if len(parts) != 2:
            results.append({"raw": pair, "error": "invalid format"})
            continue
        ip, port_str = parts
        try:
            port = int(port_str)
        except ValueError:
            results.append({"ip": ip, "port": port_str, "error": "invalid port"})
            continue
        r = _cached_query(ip, port)
        r["ip"] = ip
        r["port"] = port
        results.append(r)

    return jsonify({"results": results})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "ts": time.time()})


# ── Helpers ─────────────────────────────────────────────────────

def _cached_query(ip: str, port: int) -> dict:
    key = f"{ip}:{port}"
    now = time.time()
    with _cache_lock:
        entry = _cache.get(key)
        if entry and (now - entry[0]) < CACHE_TTL:
            return entry[1]

    result = a2s_info(ip, port)
    with _cache_lock:
        _cache[key] = (now, result)
    return result


def _err(msg: str, status: int = 400):
    return jsonify({"error": msg}), status


# ── Main (dev only) ────────────────────────────────────────────

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3000, debug=False)
