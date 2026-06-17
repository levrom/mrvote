import { cookieHeader, deleteCookieHeader, escapeHtml, formTokenInput, parseCookies, requestIp } from "../src/lib/http";
import { generateHumanCode, openJson, randomId, randomToken, sealJson } from "../src/lib/core";
import { D1BallotRepository, hashCodeInput, type Env, splitOptionsFromText } from "../src/lib/repo";
import { prepareBallot, rateLimitAttempt, submitBallot, summarizeProtocol, verifyByCode } from "../src/lib/service";
import { renderAccessCodeFormPage, renderAdminDashboardPage, renderAdminLoginPage, renderBallotPage, renderElectionCreatePage, renderElectionDetailPage, renderHomeGatePage, renderHomePage, renderProtocolPage, renderVerifiedBallotPage, renderVerificationLookupPage, renderVoteSuccessPage } from "../src/lib/render";

type PagesContext = {
  request: Request;
  env: Env;
  params: Record<string, string>;
};

function getPath(request: Request): string {
  return new URL(request.url).pathname.replace(/\/+$/, "") || "/";
}

function getFormValue(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

async function requireAdmin(request: Request, env: Env): Promise<boolean> {
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!cookies.admin_auth) return false;
  const session = await openJson<{ password: string; exp: number }>(cookies.admin_auth!, env.APP_SECRET);
  return Boolean(session && session.exp > Date.now() && session.password === env.ADMIN_PASSWORD);
}

async function createAdminCookie(env: Env): Promise<string> {
  return sealJson({ password: env.ADMIN_PASSWORD, exp: Date.now() + 12 * 60 * 60 * 1000 }, env.APP_SECRET);
}

async function createTicketCsrf(): Promise<string> {
  return randomToken(18);
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function voteTicketCookie(ticket: string, secure: boolean): string {
  return cookieHeader("vote_ticket", ticket, { maxAge: 900, sameSite: "Lax", secure });
}

function voteCsrfCookie(token: string, secure: boolean, name = "vote_csrf"): string {
  return cookieHeader(name, token, { maxAge: 900, sameSite: "Lax", secure });
}

function adminAuthCookie(ticket: string, secure: boolean): string {
  return cookieHeader("admin_auth", ticket, { maxAge: 43200, sameSite: "Lax", secure });
}

function adminCsrfCookie(token: string, secure: boolean): string {
  return cookieHeader("admin_csrf", token, { maxAge: 43200, sameSite: "Lax", secure });
}

function clearCookieSet(names: string[], secure: boolean): string[] {
  return names.map((name) => deleteCookieHeader(name, secure));
}

async function handleHomeGet(env: Env, request: Request): Promise<Response> {
  const secure = isSecureRequest(request);
  const repo = new D1BallotRepository(env.DB);
  const cookies = parseCookies(request.headers.get("cookie"));
  const gatePassword = env.HOME_PASSWORD;
  const auth = cookies.home_auth ? await openJson<{ password: string; exp: number }>(cookies.home_auth, env.APP_SECRET) : null;
  if (gatePassword) {
    if (!auth || auth.exp <= Date.now() || auth.password !== gatePassword) {
      const csrfToken = cookies.home_csrf || randomToken(18);
      return new Response(renderHomeGatePage(undefined, csrfToken), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": cookieHeader("home_csrf", csrfToken, { maxAge: 43200, sameSite: "Lax", secure }),
        },
      });
    }
  }
  const elections = await repo.listElections();
  const activeElection = elections.find((item) => item.status === "active") ?? null;
  return new Response(renderHomePage(elections, activeElection?.id ?? null), { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleHomePost(env: Env, request: Request): Promise<Response> {
  const secure = isSecureRequest(request);
  const cookies = parseCookies(request.headers.get("cookie"));
  const form = await request.formData();
  const csrfToken = getFormValue(form, "csrf_token");
  if (!cookies.home_csrf || cookies.home_csrf !== csrfToken) {
    return new Response(renderHomeGatePage("CSRF-проверка не пройдена.", cookies.home_csrf || undefined), {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 403,
    });
  }
  if (!env.HOME_PASSWORD) {
    return new Response(renderHomeGatePage("Пароль для главной не задан.", cookies.home_csrf || undefined), {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 500,
    });
  }
  const password = getFormValue(form, "password");
  if (password !== env.HOME_PASSWORD) {
    const attempt = await rateLimitAttempt(new D1BallotRepository(env.DB), env, "home-password", requestIp(request), {
      limit: 3,
      windowMs: 24 * 60 * 60 * 1000,
    });
    if (!attempt.allowed) {
      return new Response(renderHomeGatePage("Слишком много попыток. Попробуйте завтра.", cookies.home_csrf || undefined), {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 429,
      });
    }
    return new Response(renderHomeGatePage("Неверный пароль.", cookies.home_csrf || undefined), {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 401,
    });
  }
  const auth = await sealJson({ password: env.HOME_PASSWORD, exp: Date.now() + 12 * 60 * 60 * 1000 }, env.APP_SECRET);
  const response = redirect("/");
  response.headers.append("set-cookie", cookieHeader("home_auth", auth, { maxAge: 43200, sameSite: "Lax", secure }));
  response.headers.append("set-cookie", deleteCookieHeader("home_csrf", secure));
  return response;
}

async function handleAdminLoginGet(env: Env, request: Request): Promise<Response> {
  const secure = isSecureRequest(request);
  const cookies = parseCookies(request.headers.get("cookie"));
  const csrfToken = cookies.admin_csrf || randomToken(18);
  if (cookies.admin_auth) {
    const auth = await openJson<{ password: string; exp: number }>(cookies.admin_auth!, env.APP_SECRET);
    if (auth && auth.exp > Date.now() && auth.password === env.ADMIN_PASSWORD) {
      return redirect("/admin/elections");
    }
  }
  return new Response(renderAdminLoginPage(undefined, csrfToken), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": cookieHeader("admin_csrf", csrfToken, { maxAge: 43200, sameSite: "Lax", secure }),
    },
  });
}

async function handleAdminLoginPost(env: Env, request: Request): Promise<Response> {
  const secure = isSecureRequest(request);
  const cookies = parseCookies(request.headers.get("cookie"));
  const form = await request.formData();
  const password = getFormValue(form, "password");
  const csrfToken = getFormValue(form, "csrf_token");
  if (!cookies.admin_csrf || cookies.admin_csrf !== csrfToken) {
    return new Response(renderAdminLoginPage("CSRF-проверка не пройдена.", cookies.admin_csrf || undefined), { headers: { "content-type": "text/html; charset=utf-8" }, status: 403 });
  }
  if (password !== env.ADMIN_PASSWORD) {
    return new Response(renderAdminLoginPage("Неверный пароль.", cookies.admin_csrf || undefined), { headers: { "content-type": "text/html; charset=utf-8" }, status: 401 });
  }
  const authToken = await createAdminCookie(env);
  return redirect("/admin/elections", [adminAuthCookie(authToken, secure), adminCsrfCookie(cookies.admin_csrf!, secure)]);
}

async function handleAdminDashboard(env: Env, request: Request): Promise<Response> {
  if (!(await requireAdmin(request, env))) {
    return redirect("/admin");
  }
  const repo = new D1BallotRepository(env.DB);
  const elections = await repo.listElections();
  return new Response(renderAdminDashboardPage(elections), { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleElectionCreateGet(env: Env, request: Request): Promise<Response> {
  const secure = isSecureRequest(request);
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!(await requireAdmin(request, env))) {
    return redirect("/admin");
  }
  const csrfToken = cookies.admin_csrf || randomToken(18);
  return new Response(renderElectionCreatePage(undefined, csrfToken), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": cookieHeader("admin_csrf", csrfToken, { maxAge: 43200, sameSite: "Lax", secure }),
    },
  });
}

async function handleElectionCreatePost(env: Env, request: Request): Promise<Response> {
  const secure = isSecureRequest(request);
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!(await requireAdmin(request, env))) {
    return redirect("/admin");
  }
  const form = await request.formData();
  const csrfToken = getFormValue(form, "csrf_token");
  if (!cookies.admin_csrf || cookies.admin_csrf !== csrfToken) {
    return new Response(renderElectionCreatePage("CSRF-проверка не пройдена.", cookies.admin_csrf || undefined), { headers: { "content-type": "text/html; charset=utf-8" }, status: 403 });
  }
  const title = getFormValue(form, "title").trim();
  const description = getFormValue(form, "description").trim();
  const type = getFormValue(form, "type") === "multiple" ? "multiple" : "single";
  const maxSelectionsRaw = Number.parseInt(getFormValue(form, "max_selections"), 10);
  const startAt = getFormValue(form, "start_at");
  const endAt = getFormValue(form, "end_at");
  const optionLabels = splitOptionsFromText(getFormValue(form, "options"));

  if (!title || optionLabels.length < 1) {
    return new Response(renderElectionCreatePage("Нужно указать название и хотя бы один вариант.", cookies.admin_csrf || undefined), { headers: { "content-type": "text/html; charset=utf-8" }, status: 400 });
  }

  const repo = new D1BallotRepository(env.DB);
  const electionId = randomId("election_");
  const resolvedMaxSelections = type === "single" ? 1 : Number.isFinite(maxSelectionsRaw) && maxSelectionsRaw > 0 ? maxSelectionsRaw : optionLabels.length;

  await repo.createElection({
    id: electionId,
    title,
    description,
    type,
    max_selections: resolvedMaxSelections,
    status: "draft",
    start_at: startAt || null,
    end_at: endAt || null,
  });
  await repo.replaceElectionOptions(electionId, optionLabels);
  return redirect(`/admin/elections/${electionId}`);
}

async function handleElectionDetail(env: Env, request: Request, electionId: string): Promise<Response> {
  const secure = isSecureRequest(request);
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!(await requireAdmin(request, env))) {
    return redirect("/admin");
  }
  const repo = new D1BallotRepository(env.DB);
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return new Response("Голосование не найдено.", { status: 404 });
  }
  const stats = await repo.countAccessCodes(electionId);
  const totalVotes = await env.DB.prepare(`SELECT COUNT(*) AS value FROM votes WHERE election_id = ?`).bind(electionId).first<{ value: number }>();
  const csrfToken = cookies.admin_csrf || randomToken(18);
  return new Response(
    renderElectionDetailPage(
      election,
      {
        totalCodes: stats.total,
        usedCodes: stats.used,
        totalVotes: totalVotes?.value ?? 0,
      },
      csrfToken,
    ),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": cookieHeader("admin_csrf", csrfToken, { maxAge: 43200, sameSite: "Lax", secure }),
      },
    },
  );
}

async function handleElectionStatus(env: Env, request: Request, electionId: string): Promise<Response> {
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!(await requireAdmin(request, env))) {
    return redirect("/admin");
  }
  const repo = new D1BallotRepository(env.DB);
  const form = await request.formData();
  const csrfToken = getFormValue(form, "csrf_token");
  if (!cookies.admin_csrf || cookies.admin_csrf !== csrfToken) {
    return redirect(`/admin/elections/${electionId}`);
  }
  const action = getFormValue(form, "action");
  const status = action === "start" ? "active" : action === "stop" ? "stopped" : action === "close" ? "closed" : null;
  if (!status) {
    return redirect(`/admin/elections/${electionId}`);
  }
  await repo.setElectionStatus(electionId, status);
  return redirect(`/admin/elections/${electionId}`);
}

async function handleGenerateCodes(env: Env, request: Request, electionId: string): Promise<Response> {
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!(await requireAdmin(request, env))) {
    return redirect("/admin");
  }
  const repo = new D1BallotRepository(env.DB);
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return new Response("Голосование не найдено.", { status: 404 });
  }
  const form = await request.formData();
  const csrfToken = getFormValue(form, "csrf_token");
  if (!cookies.admin_csrf || cookies.admin_csrf !== csrfToken) {
    return redirect(`/admin/elections/${electionId}/codes`);
  }
  const count = Math.max(1, Number.parseInt(getFormValue(form, "count"), 10) || 0);
  const batchId = randomId("batch_");
  const codes: Array<{ code: string; hash: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const code = generateHumanCode();
    const hash = await hashCodeInput(code, env.CODE_SALT);
    codes.push({ code, hash });
  }
  await repo.createAccessCodes(
    electionId,
    codes.map((item) => item.hash),
    batchId,
  );
  const csv = ["code", ...codes.map((item) => item.code)].join("\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="access-codes-${electionId}.csv"`,
    },
  });
}

async function handleCodesPage(env: Env, request: Request, electionId: string): Promise<Response> {
  const secure = isSecureRequest(request);
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!(await requireAdmin(request, env))) {
    return redirect("/admin");
  }
  const repo = new D1BallotRepository(env.DB);
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return new Response("Голосование не найдено.", { status: 404 });
  }
  const csrfToken = cookies.admin_csrf || randomToken(18);
  const html = `
    <section class="hero">
      <div class="eyebrow">Коды доступа</div>
      <h1>${escapeHtml(election.title)}</h1>
      <p>Введите число кодов. CSV вернётся в ответе, а в базе сохранятся только хэши.</p>
    </section>
    <div class="card stack" style="max-width: 620px;">
      <form method="post" action="/admin/elections/${electionId}/codes" class="stack">
        ${formTokenInput("csrf_token", csrfToken)}
        <label>
          Количество кодов
          <input type="number" name="count" min="1" value="10" required />
        </label>
        <div class="actions">
          <button type="submit">Сгенерировать CSV</button>
          <a class="button secondary" href="/admin/elections/${electionId}">Назад</a>
        </div>
      </form>
    </div>
  `;
  return new Response(`<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Коды доступа</title></head><body><div class="container">${html}</div></body></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": cookieHeader("admin_csrf", csrfToken, { maxAge: 43200, sameSite: "Lax", secure }),
    },
  });
}

async function handleProtocolPage(env: Env, request: Request, electionId: string): Promise<Response> {
  if (!(await requireAdmin(request, env))) {
    return redirect("/admin");
  }
  const repo = new D1BallotRepository(env.DB);
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return new Response("Голосование не найдено.", { status: 404 });
  }
  const { total, used } = await repo.countAccessCodes(electionId);
  const votes = await repo.listVotesForProtocol(electionId);
  const protocol = summarizeProtocol(election, votes, total, used);
  return new Response(renderProtocolPage(protocol), { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleProtocolJson(env: Env, request: Request, electionId: string): Promise<Response> {
  if (!(await requireAdmin(request, env))) {
    return redirect("/admin");
  }
  const repo = new D1BallotRepository(env.DB);
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return new Response("Голосование не найдено.", { status: 404 });
  }
  const { total, used } = await repo.countAccessCodes(electionId);
  const votes = await repo.listVotesForProtocol(electionId);
  const protocol = summarizeProtocol(election, votes, total, used);
  return jsonResponse(protocol, {
    headers: {
      "content-disposition": `attachment; filename="protocol-${electionId}.json"`,
    },
  });
}

async function handleVoteGet(env: Env, request: Request, electionId: string): Promise<Response> {
  const secure = isSecureRequest(request);
  const repo = new D1BallotRepository(env.DB);
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return new Response("Голосование не найдено.", { status: 404 });
  }
  const csrfToken = randomToken(18);
  return new Response(renderAccessCodeFormPage(election, undefined, csrfToken), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": cookieHeader("vote_entry_csrf", csrfToken, { maxAge: 900, sameSite: "Lax", secure }),
    },
  });
}

async function handleVotePost(env: Env, request: Request, electionId: string): Promise<Response> {
  const secure = isSecureRequest(request);
  try {
    const repo = new D1BallotRepository(env.DB);
    const form = await request.formData();
    const code = getFormValue(form, "code");
    const cookies = parseCookies(request.headers.get("cookie"));
    const csrfToken = getFormValue(form, "csrf_token");
    if (!cookies.vote_entry_csrf || cookies.vote_entry_csrf !== csrfToken) {
      const election = await repo.getElectionWithOptions(electionId);
      if (!election) {
        return new Response("Голосование не найдено.", { status: 404 });
      }
      return new Response(renderAccessCodeFormPage(election, "CSRF-проверка не пройдена.", cookies.vote_entry_csrf || undefined), {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 403,
      });
    }

    const attempt = await rateLimitAttempt(repo, env, "vote-code", requestIp(request));
    if (!attempt.allowed) {
      return new Response("Слишком много попыток. Подождите минуту и попробуйте снова.", { status: 429 });
    }

    const result = await prepareBallot(repo, env, electionId, code);
    if (!result.ok) {
      const election = await repo.getElectionWithOptions(electionId);
      if (!election) {
        return new Response("Голосование не найдено.", { status: 404 });
      }
      return new Response(renderAccessCodeFormPage(election, result.message, cookies.vote_entry_csrf || undefined), {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: result.status,
      });
    }

    const ballotCsrfToken = await createTicketCsrf();
    const response = new Response(renderBallotPage(result.data.election, result.data.ticket, ballotCsrfToken), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    response.headers.append("set-cookie", voteTicketCookie(result.data.ticket, secure));
    response.headers.append("set-cookie", voteCsrfCookie(ballotCsrfToken, secure, "vote_csrf"));
    response.headers.append("set-cookie", deleteCookieHeader("vote_entry_csrf", secure));
    return response;
  } catch (error) {
    console.error("vote submission failed", error);
    const repo = new D1BallotRepository(env.DB);
    const election = await repo.getElectionWithOptions(electionId);
    if (!election) {
      return new Response("Голосование не найдено.", { status: 404 });
    }
    const fallbackCsrf = randomToken(18);
    return new Response(renderAccessCodeFormPage(election, "Не удалось открыть бюллетень. Попробуйте ещё раз.", fallbackCsrf), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": cookieHeader("vote_entry_csrf", fallbackCsrf, { maxAge: 900, sameSite: "Lax", secure }),
      },
      status: 500,
    });
  }
}

async function handleBallotGet(env: Env, request: Request, electionId: string): Promise<Response> {
  const secure = isSecureRequest(request);
  const repo = new D1BallotRepository(env.DB);
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return new Response("Голосование не найдено.", { status: 404 });
  }
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!cookies.vote_ticket) {
    return redirect(`/vote/${electionId}`);
  }
  const csrfToken = cookies.vote_csrf || (await createTicketCsrf());
  const response = new Response(renderBallotPage(election, cookies.vote_ticket, csrfToken), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  if (!cookies.vote_csrf) {
    response.headers.append("set-cookie", voteCsrfCookie(csrfToken, secure, "vote_csrf"));
  }
  return response;
}

async function handleVoteSubmit(env: Env, request: Request, electionId: string): Promise<Response> {
  const secure = isSecureRequest(request);
  const repo = new D1BallotRepository(env.DB);
  const form = await request.formData();
  const cookies = parseCookies(request.headers.get("cookie"));
  const csrf = getFormValue(form, "csrf_token");
  if (!cookies.vote_csrf || cookies.vote_csrf !== csrf) {
    return new Response("CSRF-проверка не пройдена.", { status: 403 });
  }
  const selection = form.getAll("selection").filter((value): value is string => typeof value === "string");
  const ticket = getFormValue(form, "ticket") || cookies.vote_ticket || "";
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return new Response("Голосование не найдено.", { status: 404 });
  }

  const result = await submitBallot(repo, env, ticket, electionId, selection, election.options.map((option) => option.id));
  if (!result.ok) {
    return new Response(renderBallotPage(election, ticket, cookies.vote_csrf, result.message), {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: result.status,
    });
  }

  const response = new Response(renderVoteSuccessPage(election, result.verificationCode), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  for (const cookie of clearCookieSet(["vote_ticket", "vote_csrf", "vote_entry_csrf"], secure)) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

async function handleVerifyGet(env: Env, request: Request, selectedElectionId?: string): Promise<Response> {
  const secure = isSecureRequest(request);
  const repo = new D1BallotRepository(env.DB);
  const elections = await repo.listElections();
  const csrfToken = randomToken(18);
  return new Response(renderVerificationLookupPage(elections, undefined, csrfToken, selectedElectionId), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": cookieHeader("vote_verify_csrf", csrfToken, { maxAge: 900, sameSite: "Lax", secure }),
    },
  });
}

async function handleVerifyPost(env: Env, request: Request): Promise<Response> {
  const secure = isSecureRequest(request);
  const repo = new D1BallotRepository(env.DB);
  const elections = await repo.listElections();
  const form = await request.formData();
  const cookies = parseCookies(request.headers.get("cookie"));
  const electionId = getFormValue(form, "electionId");
  const verificationCode = getFormValue(form, "verificationCode");
  const csrfToken = getFormValue(form, "csrf_token");
  if (!cookies.vote_verify_csrf || cookies.vote_verify_csrf !== csrfToken) {
    return new Response(renderVerificationLookupPage(elections, "CSRF-проверка не пройдена.", cookies.vote_verify_csrf || undefined, electionId || undefined), { headers: { "content-type": "text/html; charset=utf-8" }, status: 403 });
  }
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return new Response(renderVerificationLookupPage(elections, "Голосование не найдено.", cookies.vote_verify_csrf || undefined, electionId || undefined), { headers: { "content-type": "text/html; charset=utf-8" }, status: 404 });
  }
  const result = await verifyByCode(repo, electionId, verificationCode);
  if (!result.ok) {
    return new Response(renderVerificationLookupPage(elections, result.message, cookies.vote_verify_csrf || undefined, electionId || undefined), { headers: { "content-type": "text/html; charset=utf-8" }, status: result.status });
  }
  const response = new Response(renderVerifiedBallotPage(election, result.vote), { headers: { "content-type": "text/html; charset=utf-8" } });
  if (!cookies.vote_verify_csrf) {
    response.headers.append("set-cookie", cookieHeader("vote_verify_csrf", csrfToken || randomToken(18), { maxAge: 900, sameSite: "Lax", secure }));
  }
  return response;
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const method = request.method.toUpperCase();
  const path = getPath(request);
  const segments = path.split("/").filter(Boolean);

  if (method === "GET" && path === "/") {
    return handleHomeGet(env, request);
  }
  if (method === "POST" && path === "/") {
    return handleHomePost(env, request);
  }

  if (segments[0] === "admin") {
    if (method === "GET" && path === "/admin") {
      return handleAdminLoginGet(env, request);
    }
    if (method === "POST" && path === "/admin") {
      return handleAdminLoginPost(env, request);
    }
    if (method === "GET" && path === "/admin/elections") {
      return handleAdminDashboard(env, request);
    }
    if (method === "GET" && path === "/admin/elections/new") {
      return handleElectionCreateGet(env, request);
    }
    if (method === "POST" && path === "/admin/elections/new") {
      return handleElectionCreatePost(env, request);
    }
    if (segments[1] === "elections" && segments[2]) {
      const electionId = segments[2];
      if (segments.length === 3 && method === "GET") {
        return handleElectionDetail(env, request, electionId);
      }
      if (segments.length === 3 && method === "POST") {
        return handleElectionStatus(env, request, electionId);
      }
      if (segments[3] === "codes" && method === "GET") {
        return handleCodesPage(env, request, electionId);
      }
      if (segments[3] === "codes" && method === "POST") {
        return handleGenerateCodes(env, request, electionId);
      }
      if (segments[3] === "protocol" && method === "GET") {
        return handleProtocolPage(env, request, electionId);
      }
      if (segments[3] === "export.json" && method === "GET") {
        return handleProtocolJson(env, request, electionId);
      }
    }
  }

  if (segments[0] === "vote" && segments[1]) {
    const electionId = segments[1];
    if (segments.length === 2 && method === "GET") {
      return handleVoteGet(env, request, electionId);
    }
    if (segments.length === 2 && method === "POST") {
      return handleVotePost(env, request, electionId);
    }
    if (segments[2] === "ballot" && method === "GET") {
      return handleBallotGet(env, request, electionId);
    }
    if (segments[2] === "submit" && method === "POST") {
      return handleVoteSubmit(env, request, electionId);
    }
  }

  if (segments[0] === "verify") {
    if (method === "GET") {
      return handleVerifyGet(env, request, segments[1]);
    }
    if (method === "POST") {
      return handleVerifyPost(env, request);
    }
  }

  return new Response("Not found", { status: 404 });
}
