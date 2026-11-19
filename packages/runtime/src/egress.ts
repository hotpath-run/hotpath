// Outbound calls to addresses a customer gave us (a remote tool server, a model
// endpoint). In hosted mode such a URL must never reach our own network: no
// private, loopback, link-local, shared (CGNAT) or cloud metadata addresses,
// https only. The address is checked at connect time (the socket's own DNS
// lookup), so a name that resolves to a public address for the check and to a
// private one for the connection (DNS rebinding) is refused as well, and every
// redirect hop goes through the same check.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export class EgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressError";
  }
}

const v4ToInt = (ip: string): number =>
  ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

const V4_BLOCKED: Array<[string, number, string]> = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared (CGNAT)"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved / broadcast"],
];

function blockedV4(ip: string): string | null {
  const n = v4ToInt(ip);
  for (const [base, bits, why] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0) return why;
  }
  return null;
}

/** Eight 16-bit groups of an IPv6 address (handles `::` and a trailing IPv4). */
function v6Groups(ip: string): number[] {
  let text = ip.toLowerCase().split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    text = text.replace(
      v4[1]!,
      `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`,
    );
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const parse = (s: string) =>
    s ? s.split(":").map((g) => parseInt(g, 16)) : [];
  const h = parse(head);
  const t = tail === undefined ? [] : parse(tail);
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill(0);
  return [...h, ...fill, ...t];
}

function blockedV6(ip: string): string | null {
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return "unparseable";
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the IPv4 inside
  const embedded =
    (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) ||
    (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (embedded) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
    return blockedV4(v4);
  }
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique local (private)";
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0]! & 0xff00) === 0xff00) return "multicast";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation";
  return null;
}

/** Why an IP address must not be called from hosted mode, or null when it may. */
export function forbiddenAddress(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) return blockedV4(ip);
  if (family === 6) return blockedV6(ip);
  return "not an IP address";
}

/** Checks a URL's shape (before any DNS lookup). Throws EgressError. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError(`not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:") {
    throw new EgressError(
      `${url.origin}: only https:// is allowed for remote tools in hosted mode`,
    );
  }
  if (url.username || url.password) {
    throw new EgressError(
      `${url.host}: credentials in the URL are refused; send them as a header`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    const why = forbiddenAddress(host);
    if (why) throw new EgressError(`${host} is a ${why} address: refused`);
  } else if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new EgressError(`${host} is a local name: refused`);
  }
  return url;
}

type LookupFn = typeof dnsLookup;

/** A DNS lookup for sockets that refuses forbidden answers (no rebinding window). */
export function guardedLookup(resolve: LookupFn = dnsLookup): LookupFn {
  const lookup = ((
    hostname: string,
    options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as LookupAddress[];
      for (const a of list) {
        const why = forbiddenAddress(a.address);
        if (why) {
          return callback(
            new EgressError(
              `${hostname} resolves to ${a.address}, a ${why} address: refused`,
            ) as NodeJS.ErrnoException,
            "",
            0,
          );
        }
      }
      const all = (options as { all?: boolean } | undefined)?.all;
      if (all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as LookupFn;
  return lookup;
}

export interface EgressLimits {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  lookup?: LookupFn;
}

/**
 * fetch() for hosted mode: https only, every hop's address checked when the
 * socket connects, redirects followed by hand (each one checked), and a time
 * and size limit on the whole call.
 */
export function guardedFetch(limits: EgressLimits = {}) {
  const timeoutMs = limits.timeoutMs ?? 30_000;
  const maxBytes = limits.maxBytes ?? 10 * 1024 * 1024;
  const maxRedirects = limits.maxRedirects ?? 3;
  const lookup = guardedLookup(limits.lookup);

  const once = (url: URL, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const req = https.request(
        url,
        { method: init.method ?? "GET", headers, lookup, timeout: timeoutMs },
        (res) => {
          let seen = 0;
          res.on("data", (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > maxBytes) {
              res.destroy(
                new EgressError(
                  `${url.host} sent more than ${maxBytes} bytes: stopped`,
                ),
              );
            }
          });
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined)
              out.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          const status = res.statusCode ?? 0;
          const body =
            status === 204 || status === 304
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
          resolve(new Response(body, { status, headers: out }));
        },
      );
      req.on("timeout", () =>
        req.destroy(
          new EgressError(`${url.host} did not answer in ${timeoutMs} ms`),
        ),
      );
      req.on("error", reject);
      init.signal?.addEventListener("abort", () =>
        req.destroy(new EgressError("aborted")),
      );
      if (typeof init.body === "string") req.end(init.body);
      else req.end();
    });

  return async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    let url = checkUrl(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    for (let hop = 0; ; hop++) {
      const res = await once(url, init);
      if (res.status < 300 || res.status >= 400 || res.status === 304) {
        return res;
      }
      const next = res.headers.get("location");
      if (!next) return res;
      if (hop >= maxRedirects) {
        throw new EgressError(`more than ${maxRedirects} redirects: stopped`);
      }
      url = checkUrl(new URL(next, url).href);
      // as fetch does: 303, and 301/302 after a POST, continue as a GET
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && init.method === "POST")
      ) {
        init = { ...init, method: "GET", body: undefined };
      }
    }
  };
}
