import { randomToken } from "./core";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

export function page(title: string, body: string, description = "Тайное голосование"): string {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeAttr(description)}" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div class="container">
      ${body}
    </div>
  </body>
</html>`;
}

export function layout(title: string, body: string, description?: string): string {
  return page(title, body, description);
}

export function renderNotice(type: "success" | "error" | "warning", text: string): string {
  return `<div class="notice ${type}">${escapeHtml(text)}</div>`;
}

export function cookieHeader(name: string, value: string, options: { httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" | "Strict" | "None"; path?: string; maxAge?: number } = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.secure ?? false) parts.push("Secure");
  if (options.httpOnly ?? true) parts.push("HttpOnly");
  return parts.join("; ");
}

export function deleteCookieHeader(name: string, secure = false): string {
  return cookieHeader(name, "", { maxAge: 0, secure });
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((chunk) => {
      const [name, ...rest] = chunk.trim().split("=");
      return [name, decodeURIComponent(rest.join("="))];
    }),
  );
}

export function requestIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0";
}

export function ensureToken(current: string | undefined, length = 18): { value: string; shouldSetCookie: boolean } {
  if (current) {
    return { value: current, shouldSetCookie: false };
  }
  return { value: randomToken(length), shouldSetCookie: true };
}

export function formTokenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}" />`;
}

export function actionRow(left: string, right = ""): string {
  return `<div class="row">${left}<div class="spacer"></div>${right}</div>`;
}
