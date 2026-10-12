/**
 * STUDIO ON THE LOCAL NETWORK: a phone, a tablet or another PC on the same
 * Wi-Fi uses this PC's Studio. Off unless the launcher starts Studio with it
 * (the phone on a mode's card): AIPLAY_LAN=1 and AIPLAY_LAN_KEY.
 *
 * Studio's whole safety model is "only this PC's own address": every route
 * refuses another Host (index.js foreignHost), and the doors that spend money
 * or choose what runs also want a same-origin JSON request
 * (sameOriginLocalJson). Opening the port to the network must not open those
 * to anyone on the Wi-Fi, so a device that is not this PC needs the access key
 * first: the launcher's link carries it once (?k=…), Studio swaps it for an
 * HttpOnly, SameSite=Strict cookie and redirects to the same page without it.
 * Every later request must carry that cookie. Only then is the request shown
 * to the checks below as this PC's own (Host and Origin rewritten to
 * 127.0.0.1), so each existing rule still applies exactly as it does here.
 *
 * Refused without the key: everything, with one short page saying where the
 * link is. The Host must be a bare IPv4 address on Studio's port, so a DNS name
 * (a rebinding page on the same network) never gets in, even with the cookie.
 */
import crypto from "node:crypto";
import os from "node:os";

export const LAN_COOKIE = "aiplay_lan";
const KEY_RE = /^[A-Za-z0-9_-]{24,128}$/;

/** What the launcher asked for. A missing or short key keeps Studio local. */
export function lanConfig(env = process.env) {
  if (env.AIPLAY_LAN !== "1") return { on: false, key: null, why: null };
  const key = String(env.AIPLAY_LAN_KEY || "");
  if (!KEY_RE.test(key)) {
    return { on: false, key: null, why: "AIPLAY_LAN is on but its access key is missing or too short, so Studio stays on this PC only." };
  }
  return { on: true, key, why: null };
}

/** A new access key: 32 random bytes, URL-safe. */
export function newLanKey() {
  return crypto.randomBytes(32).toString("base64url");
}

export function isLoopbackAddress(addr) {
  const a = String(addr || "");
  return a === "::1" || /^127\./.test(a) || /^::ffff:127\./i.test(a);
}

/* Adapters that are not the Wi-Fi or the cable a phone shares: virtual
 * switches, VPNs and VM networks. Their addresses are listed last. */
const VIRTUAL = /(vEthernet|Hyper-V|VirtualBox|VMware|WSL|Docker|Loopback|Bluetooth|TAP|Tailscale|ZeroTier|WireGuard|VPN|vboxnet|virbr|docker|br-)/i;
const PRIVATE = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/** This PC's IPv4 addresses a phone on the same network can reach, best first. */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const i of list || []) {
      const v4 = i.family === "IPv4" || i.family === 4;
      if (!v4 || i.internal || !i.address || /^169\.254\./.test(i.address)) continue;
      out.push({ ip: i.address, name, rank: (VIRTUAL.test(name) ? 2 : 0) + (PRIVATE(i.address) ? 0 : 1) });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ ip, name }) => ({ ip, name }));
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

const REFUSED = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIPLAY Studio</title>
<body style="font:15px system-ui,sans-serif;background:#0b0e14;color:#e8ecf3;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box">
<div style="max-width:420px"><h1 style="font-size:20px;margin:0 0 10px">This Studio needs its link</h1>
<p style="color:#9aa4b2;line-height:1.5;margin:0">Open the link from the AIPLAY launcher on the PC running Studio: the phone button on the running app shows it, with a Copy button. The link carries a one-time key, so typing the address alone is not enough.</p></div></body>`;

/**
 * The gate, run first on every request. Returns "local" (this PC: untouched),
 * "lan" (a device with the key: its Host and Origin now read as this PC's), or
 * "handled" (answered here: the key swapped for the cookie, or refused).
 */
export function createLanGate({ key, port }) {
  const want = Buffer.from(String(key));
  const matches = (v) => {
    const got = Buffer.from(String(v || ""));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  const ipHost = (host) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d+)$/.exec(String(host || ""));
    return !!m && Number(m[5]) === Number(port) && m.slice(1, 5).every((n) => Number(n) <= 255);
  };
  /* Shared by HTTP and the live socket: rewrite an authorised request so the
   * rules below treat it as this PC's own page. */
  const admit = (req) => {
    const lanOrigin = `http://${req.headers.host}`;
    req.headers.host = `127.0.0.1:${port}`;
    if (req.headers.origin === lanOrigin) req.headers.origin = `http://127.0.0.1:${port}`;
    req.lanClient = true;
  };

  function http(req, res) {
    if (isLoopbackAddress(req.socket?.remoteAddress)) return "local";
    const refuse = () => {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end(REFUSED);
      return "handled";
    };
    if (!ipHost(req.headers.host)) return refuse();
    const url = new URL(req.url, "http://lan.invalid");
    const k = url.searchParams.get("k");
    if (k !== null) {
      if (!matches(k)) return refuse();
      url.searchParams.delete("k");
      res.writeHead(302, {
        Location: url.pathname + url.search,
        "Set-Cookie": `${LAN_COOKIE}=${want.toString()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      });
      res.end();
      return "handled";
    }
    if (!matches(cookieValue(req, LAN_COOKIE))) return refuse();
    admit(req);
    return "lan";
  }

  /** The live socket: the verifier must require this result before its Host
   *  and Origin checks. A remote client can supply a loopback Host itself, so
   *  leaving an unauthorised request untouched would not refuse that client. */
  function upgrade(req) {
    if (isLoopbackAddress(req.socket?.remoteAddress)) return true;
    if (!ipHost(req.headers.host) || !matches(cookieValue(req, LAN_COOKIE))) return false;
    admit(req);
    return true;
  }

  return { http, upgrade };
}
