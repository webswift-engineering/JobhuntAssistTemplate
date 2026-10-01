import type { Express, Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import type { DB } from "./db/client.js";
import { findUserByToken, OWNER_USER_ID } from "./users.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Resolved account for this request (owner = 1). Set by mountAuth. */
      userId?: number;
    }
  }
}

const COOKIE = "jha_token";
const seenRemoteClients = new Set<string>();
const YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/** True when an access token is configured (auth is enforced). */
export function authEnabled(): boolean {
  return !!config.accessToken;
}

/** Requests from the local machine itself are trusted (the original localhost model). */
function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.") ||
    addr.startsWith("::ffff:127.")
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Pull a candidate token from header, bearer auth, cookie, or query (in that order). */
function tokenFromRequest(req: Request): { token: string | null; fromQuery: boolean } {
  const header = req.header("x-access-token");
  if (header) return { token: header, fromQuery: false };

  const auth = req.header("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    return { token: auth.replace(/^Bearer\s+/i, "").trim(), fromQuery: false };
  }

  const cookies = parseCookies(req.header("cookie"));
  if (cookies[COOKIE]) return { token: cookies[COOKIE]!, fromQuery: false };

  const q = req.query.token;
  if (typeof q === "string" && q) return { token: q, fromQuery: true };

  return { token: null, fromQuery: false };
}

function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: YEAR_MS,
    path: "/",
  });
}

function loginPage(next: string, error: boolean): string {
  const safeNext = next.replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Job Hunt Assistant — Sign in</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0f1115; color:#e6e9ef; font:15px -apple-system,"Segoe UI",Roboto,sans-serif; }
  .card { width:min(360px,92vw); background:#161a22; border:1px solid #2a2f3a; border-radius:14px;
    padding:26px 24px; box-shadow:0 10px 40px rgba(0,0,0,.4); }
  h1 { font-size:18px; margin:0 0 4px; }
  p { color:#8b93a7; font-size:13px; margin:0 0 18px; }
  label { display:block; font-size:12px; color:#8b93a7; margin-bottom:6px; }
  input { width:100%; box-sizing:border-box; background:#0f1115; color:#e6e9ef; border:1px solid #2a2f3a;
    border-radius:8px; padding:11px 12px; font:inherit; }
  button { margin-top:14px; width:100%; background:#3b82f6; color:#fff; border:0; border-radius:8px;
    padding:11px; font:inherit; font-weight:600; cursor:pointer; }
  button:hover { background:#2f6fe0; }
  .err { color:#ff7b72; font-size:13px; margin-top:12px; }
</style></head>
<body>
  <form class="card" method="POST" action="/login">
    <h1>Job Hunt Assistant</h1>
    <p>Enter your access token to continue.</p>
    <input type="hidden" name="next" value="${safeNext}" />
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" autofocus />
    <button type="submit">Sign in</button>
    ${error ? '<div class="err">Incorrect access token.</div>' : ""}
  </form>
</body></html>`;
}

/**
 * Register login/logout routes and the guard. Must be called before the API +
 * static. Every request gets req.userId: loopback requests (and everything when
 * auth is disabled) act as the owner; remote requests resolve their token to an
 * account in the users table.
 */
export function mountAuth(app: Express, db: DB): void {
  if (!authEnabled()) {
    // Localhost-only mode (no ACCESS_TOKEN): everything is the owner.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.userId = OWNER_USER_ID;
      next();
    });
    return;
  }

  app.get("/login", (req: Request, res: Response) => {
    const next = typeof req.query.next === "string" ? req.query.next : "/";
    res.type("html").send(loginPage(next, req.query.error === "1"));
  });

  app.post("/login", async (req: Request, res: Response) => {
    const token = String((req.body?.token ?? "")).trim();
    const next = typeof req.body?.next === "string" && req.body.next ? req.body.next : "/";
    const user = token ? await findUserByToken(db, token) : undefined;
    if (user) {
      setAuthCookie(res, token);
      res.redirect(next.startsWith("/") ? next : "/");
    } else {
      res.status(401).redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
    }
  });

  app.get("/logout", (_req: Request, res: Response) => {
    res.clearCookie(COOKIE, { path: "/" });
    res.redirect("/login");
  });

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    // Local machine (extension, local dashboard) is trusted without a token —
    // only remote / Tailscale / LAN requests must authenticate. Loopback is the
    // owner's own PC, so it acts as the owner account.
    if (isLoopbackAddress(req.socket.remoteAddress)) {
      req.userId = OWNER_USER_ID;
      return next();
    }

    const { token, fromQuery } = tokenFromRequest(req);
    const user = token ? await findUserByToken(db, token) : undefined;
    if (user) {
      req.userId = user.id;
      // Once per (client, account) per boot: "who is this remote client acting
      // as?" must be answerable from server.log — a client on the owner's own PC
      // reaching the Tailscale address with another account's token shows here.
      const key = `${req.socket.remoteAddress}→${user.id}`;
      if (!seenRemoteClients.has(key)) {
        seenRemoteClients.add(key);
        console.log(`[auth] remote client ${req.socket.remoteAddress} acts as "${user.name}" (id ${user.id})`);
      }
      if (fromQuery) setAuthCookie(res, token!);
      return next();
    }
    const wantsHtml = (req.header("accept") ?? "").includes("text/html");
    if (wantsHtml && req.method === "GET") {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    } else {
      res.status(401).json({ error: "unauthorized" });
    }
  });
}
