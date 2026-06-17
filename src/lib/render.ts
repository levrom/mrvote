import { escapeHtml, formTokenInput, layout, renderNotice } from "./http";
import type { ElectionListItem, ElectionWithOptions, ProtocolResult, VoteRecord } from "./repo";
import { toDisplayCode } from "./core";
import { parseBallotJson } from "./repo";

function statusPill(status: string): string {
  if (status === "active") return `<span class="pill success">активно</span>`;
  if (status === "draft") return `<span class="pill warning">черновик</span>`;
  if (status === "stopped") return `<span class="pill danger">остановлено</span>`;
  return `<span class="pill">закрыто</span>`;
}

function electionMeta(election: Pick<ElectionWithOptions, "type" | "max_selections" | "status" | "start_at" | "end_at">): string {
  const parts = [
    election.type === "single" ? "Один вариант" : `Несколько вариантов до ${election.max_selections ?? 0}`,
    election.start_at ? `Старт: ${escapeHtml(election.start_at)}` : null,
    election.end_at ? `Окончание: ${escapeHtml(election.end_at)}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function renderHomePage(elections: ElectionListItem[], activeElectionId: string | null): string {
  const rows = elections
    .map(
      (election) => `
      <tr>
        <td>
          <strong>${escapeHtml(election.title)}</strong><br />
          <span class="muted">${escapeHtml(election.description || "Без описания")}</span>
        </td>
        <td>${statusPill(election.status)}</td>
        <td>${escapeHtml(election.type === "single" ? "Один вариант" : "Несколько вариантов")}</td>
        <td>${election.total_votes}</td>
        <td>${election.total_codes}</td>
        <td>${election.used_codes}</td>
        <td>${election.id === activeElectionId ? `<a class="button" href="/vote/${election.id}">Голосовать</a>` : `<a href="/verify/${election.id}">Проверить бюллетень</a>`}</td>
      </tr>
    `,
    )
    .join("");

  return layout(
    "Тайное голосование",
    `
      <section class="hero">
        <div class="eyebrow">Cloudflare Pages · Pages Functions · D1</div>
        <h1>Тайное голосование без связи между кодом доступа и бюллетенем</h1>
        <p>Публичный интерфейс для участников и отдельная админка для счётной комиссии. Голос хранится отдельно от одноразового кода доступа.</p>
      </section>

      <div class="grid two">
        <div class="card stack">
          <h2>Доступные голосования</h2>
          <table>
            <thead>
              <tr>
                <th>Голосование</th>
                <th>Статус</th>
                <th>Тип</th>
                <th>Голоса</th>
                <th>Коды</th>
                <th>Использовано</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="7" class="muted">Пока нет голосований.</td></tr>`}</tbody>
          </table>
        </div>

        <div class="card stack">
          <h2>Что умеет система</h2>
          <div class="checks">
            <div class="check-item"><span>1.</span><div>Одноразовый код открывает только бюллетень.</div></div>
            <div class="check-item"><span>2.</span><div>При отправке голоса код гасится в одной SQL-операции.</div></div>
            <div class="check-item"><span>3.</span><div>Протокол содержит только бюллетени и коды проверки.</div></div>
            <div class="check-item"><span>4.</span><div>Админка защищена паролем из секретов Cloudflare.</div></div>
          </div>
          <div class="actions">
            <a class="button secondary" href="/admin">Открыть админку</a>
          </div>
        </div>
      </div>
    `,
  );
}

export function renderAdminLoginPage(error?: string, csrfToken?: string): string {
  return layout(
    "Вход в админку",
    `
      <section class="hero">
        <div class="eyebrow">Администрирование</div>
        <h1>Вход в админку</h1>
        <p>Пароль задаётся через Cloudflare Pages secrets.</p>
      </section>
      <div class="card stack" style="max-width: 540px;">
        ${error ? renderNotice("error", error) : ""}
        <form method="post" action="/admin">
          <div class="stack">
            ${csrfToken ? formTokenInput("csrf_token", csrfToken) : ""}
            <label>
              Пароль
              <input type="password" name="password" autocomplete="current-password" required />
            </label>
            <button type="submit">Войти</button>
          </div>
        </form>
      </div>
    `,
  );
}

export function renderAdminDashboardPage(elections: ElectionListItem[]): string {
  const rows = elections
    .map(
      (election) => `
        <tr>
          <td><strong>${escapeHtml(election.title)}</strong><br /><span class="muted">${escapeHtml(election.description || "Без описания")}</span></td>
          <td>${statusPill(election.status)}</td>
          <td>${escapeHtml(election.type === "single" ? "Один вариант" : "Несколько вариантов")}</td>
          <td>${election.total_codes}</td>
          <td>${election.used_codes}</td>
          <td>${election.total_votes}</td>
          <td><a href="/admin/elections/${election.id}">Открыть</a></td>
        </tr>
      `,
    )
    .join("");

  return layout(
    "Админка",
    `
      <section class="hero">
        <div class="eyebrow">Администрирование</div>
        <h1>Счётная комиссия</h1>
        <p>Создавайте голосования, выдавайте коды и формируйте протоколы без скрытых связок между кодом доступа и бюллетенем.</p>
      </section>

      <div class="actions" style="margin-bottom: 18px;">
        <a class="button" href="/admin/elections/new">Новое голосование</a>
        <a class="button secondary" href="/">На публичную страницу</a>
      </div>

      <div class="card stack">
        <h2>Голосования</h2>
        <table>
          <thead>
            <tr>
              <th>Название</th>
              <th>Статус</th>
              <th>Тип</th>
              <th>Коды</th>
              <th>Использовано</th>
              <th>Голоса</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="7" class="muted">Пока ничего нет.</td></tr>`}</tbody>
        </table>
      </div>
    `,
  );
}

export function renderElectionCreatePage(error?: string, csrfToken?: string): string {
  return layout(
    "Новое голосование",
    `
      <section class="hero">
        <div class="eyebrow">Администрирование</div>
        <h1>Создать голосование</h1>
        <p>Список вариантов вводится построчно. Для типа «несколько вариантов» укажите максимальное число выбора.</p>
      </section>

      <div class="card stack">
        ${error ? renderNotice("error", error) : ""}
        <form method="post" action="/admin/elections/new" class="stack">
          ${csrfToken ? formTokenInput("csrf_token", csrfToken) : ""}
          <label>
            Название
            <input name="title" required />
          </label>
          <label>
            Описание
            <textarea name="description" placeholder="Краткое описание голосования"></textarea>
          </label>
          <div class="grid two">
            <label>
              Тип
              <select name="type" id="election-type">
                <option value="single">Один вариант</option>
                <option value="multiple">Несколько вариантов</option>
              </select>
            </label>
            <label>
              Максимум выбранных вариантов
              <input type="number" name="max_selections" min="1" value="1" />
            </label>
          </div>
          <div class="grid two">
            <label>
              Дата начала
              <input type="datetime-local" name="start_at" />
            </label>
            <label>
              Дата окончания
              <input type="datetime-local" name="end_at" />
            </label>
          </div>
          <label>
            Варианты
            <textarea name="options" required placeholder="Иванов&#10;Петров&#10;Сидоров"></textarea>
          </label>
          <div class="actions">
            <button type="submit">Создать</button>
            <a class="button secondary" href="/admin">Отмена</a>
          </div>
        </form>
      </div>

      <script>
        const typeInput = document.getElementById('election-type');
        const maxInput = document.querySelector('input[name="max_selections"]');
        const sync = () => { maxInput.disabled = typeInput.value === 'single'; if (typeInput.value === 'single') maxInput.value = 1; };
        typeInput.addEventListener('change', sync);
        sync();
      </script>
    `,
  );
}

export function renderElectionDetailPage(
  election: ElectionWithOptions,
  stats: { totalCodes: number; usedCodes: number; totalVotes: number },
  csrfToken?: string,
  error?: string,
  message?: string,
): string {
  const options = election.options
    .map((option) => `<li><strong>${escapeHtml(option.label)}</strong> <span class="muted">#${option.sort_order}</span></li>`)
    .join("");

  return layout(
    election.title,
    `
      <section class="hero">
        <div class="eyebrow">Управление голосованием</div>
        <h1>${escapeHtml(election.title)}</h1>
        <p>${escapeHtml(election.description || "Без описания")}</p>
        <div class="row">
          ${statusPill(election.status)}
          <span class="pill">${escapeHtml(election.type === "single" ? "Один вариант" : `Несколько вариантов до ${election.max_selections ?? 0}`)}</span>
          <span class="pill">${escapeHtml(election.start_at ? `Старт: ${election.start_at}` : "Старт не задан")}</span>
          <span class="pill">${escapeHtml(election.end_at ? `Окончание: ${election.end_at}` : "Окончание не задано")}</span>
        </div>
      </section>

      ${error ? renderNotice("error", error) : ""}
      ${message ? renderNotice("success", message) : ""}

      <div class="kpis">
        <div class="card kpi"><span class="muted">Выдано кодов</span><strong>${stats.totalCodes}</strong></div>
        <div class="card kpi"><span class="muted">Использовано кодов</span><strong>${stats.usedCodes}</strong></div>
        <div class="card kpi"><span class="muted">Бюллетеней</span><strong>${stats.totalVotes}</strong></div>
      </div>

      <div class="grid two" style="margin-top: 18px;">
        <div class="card stack">
          <h2>Варианты</h2>
          <ol class="checklist">${options}</ol>
          <div class="actions">
            <a class="button secondary" href="/admin/elections/${election.id}/codes">Сгенерировать коды</a>
            <a class="button secondary" href="/admin/elections/${election.id}/protocol">Протокол</a>
          </div>
        </div>

        <div class="card stack">
          <h2>Действия</h2>
          <form method="post" action="/admin/elections/${election.id}" class="stack">
            ${csrfToken ? formTokenInput("csrf_token", csrfToken) : ""}
            <div class="actions">
              <button name="action" value="start" type="submit">Старт</button>
              <button name="action" value="stop" type="submit" class="button secondary">Стоп</button>
              <button name="action" value="close" type="submit" class="button danger">Закрыть</button>
            </div>
          </form>
        </div>
      </div>

      <div class="card stack" style="margin-top: 18px;">
        <h2>Подсказка для комиссии</h2>
        <p>Коды доступа можно выдавать только в открытом виде при генерации CSV. После этого в базе остаются только хэши.</p>
      </div>
    `,
  );
}

export function renderAccessCodeFormPage(election: ElectionWithOptions, error?: string, csrfToken?: string): string {
  return layout(
    election.title,
    `
      <section class="hero">
        <div class="eyebrow">Участник</div>
        <h1>${escapeHtml(election.title)}</h1>
        <p>${escapeHtml(election.description || "Без описания")}</p>
      </section>
      <div class="card stack" style="max-width: 620px;">
        ${error ? renderNotice("error", error) : ""}
        <div class="pill">${escapeHtml(election.type === "single" ? "Выбор одного варианта" : `Можно выбрать до ${election.max_selections ?? 0} вариантов`)}</div>
        <form method="post" action="/vote/${election.id}" class="stack">
          ${csrfToken ? formTokenInput("csrf_token", csrfToken) : ""}
          <label>
            Одноразовый код доступа
            <input name="code" autocomplete="one-time-code" inputmode="latin" required />
          </label>
          <div class="actions">
            <button type="submit">Открыть бюллетень</button>
            <a class="button secondary" href="/">Назад</a>
          </div>
        </form>
      </div>
    `,
  );
}

export function renderBallotPage(election: ElectionWithOptions, ticket: string, csrfToken: string, error?: string): string {
  const inputs = election.options
    .map(
      (option) => `
        <label class="check-item">
          <input type="${election.type === "single" ? "radio" : "checkbox"}" name="selection" value="${escapeHtml(option.id)}" />
          <span><strong>${escapeHtml(option.label)}</strong></span>
        </label>
      `,
    )
    .join("");

  const max = election.type === "single" ? 1 : election.max_selections ?? 1;

  return layout(
    `Бюллетень — ${election.title}`,
    `
      <section class="hero">
        <div class="eyebrow">Бюллетень</div>
        <h1>${escapeHtml(election.title)}</h1>
        <p>${escapeHtml(electionMeta(election))}</p>
      </section>
      <div class="card stack">
        ${error ? renderNotice("error", error) : ""}
        <form method="post" action="/vote/${election.id}/submit" id="ballot-form" class="stack">
          <input type="hidden" name="ticket" value="${escapeHtml(ticket)}" />
          ${formTokenInput("csrf_token", csrfToken)}
          <div class="pill">Выберите ${election.type === "single" ? "ровно один вариант" : `не более ${max} вариантов`}</div>
          <div class="checks">${inputs}</div>
          <div class="actions">
            <button type="submit">Проголосовать</button>
            <a class="button secondary" href="/vote/${election.id}">Отменить</a>
          </div>
        </form>
      </div>
      <script>
        const form = document.getElementById('ballot-form');
        const max = ${JSON.stringify(max)};
        const type = ${JSON.stringify(election.type)};
        const nodes = [...form.querySelectorAll('input[name="selection"]')];
        const update = () => {
          const checked = nodes.filter((node) => node.checked);
          if (type === 'single') return;
          nodes.forEach((node) => {
            node.disabled = !node.checked && checked.length >= max;
          });
        };
        nodes.forEach((node) => node.addEventListener('change', update));
        update();
      </script>
    `,
  );
}

export function renderVoteSuccessPage(election: ElectionWithOptions, verificationCode: string): string {
  return layout(
    "Голос принят",
    `
      <section class="hero">
        <div class="eyebrow">Голос учтён</div>
        <h1>Спасибо. Бюллетень сохранён.</h1>
        <p>Сохраните код проверки. По нему можно убедиться, что ваш бюллетень учтён в протоколе.</p>
      </section>
      <div class="card stack" style="max-width: 720px;">
        <div class="notice success">Код проверки: <strong>${escapeHtml(toDisplayCode(verificationCode))}</strong></div>
        <div class="actions">
          <a class="button" href="/verify/${election.id}">Проверить бюллетень</a>
          <a class="button secondary" href="/">На главную</a>
        </div>
      </div>
    `,
  );
}

export function renderVerificationLookupPage(elections: ElectionListItem[], error?: string, csrfToken?: string, selectedElectionId?: string): string {
  const options = elections
    .map((election) => `<option value="${escapeHtml(election.id)}"${selectedElectionId === election.id ? " selected" : ""}>${escapeHtml(election.title)} (${escapeHtml(election.status)})</option>`)
    .join("");

  return layout(
    "Проверка бюллетеня",
    `
      <section class="hero">
        <div class="eyebrow">Проверка</div>
        <h1>Проверить бюллетень</h1>
        <p>Введите код проверки, который был выдан после голосования.</p>
      </section>

      <div class="card stack" style="max-width: 720px;">
        ${error ? renderNotice("error", error) : ""}
        <form method="post" action="/verify" class="stack">
          ${csrfToken ? formTokenInput("csrf_token", csrfToken) : ""}
          <label>
            Голосование
            <select name="electionId" required>
              <option value="">Выберите голосование</option>
              ${options}
            </select>
          </label>
          <label>
            Код проверки
            <input name="verificationCode" required />
          </label>
          <div class="actions">
            <button type="submit">Проверить</button>
          </div>
        </form>
      </div>
    `,
  );
}

export function renderVerifiedBallotPage(election: ElectionWithOptions, vote: VoteRecord): string {
  const selected = parseBallotJson(vote.ballot_json);
  const lines = election.options
    .filter((option) => selected.includes(option.id))
    .map((option) => `<li><strong>${escapeHtml(option.label)}</strong></li>`)
    .join("");

  return layout(
    "Бюллетень учтён",
    `
      <section class="hero">
        <div class="eyebrow">Проверка</div>
        <h1>Бюллетень найден</h1>
        <p>Код проверки подтверждает, что бюллетень учтён. Access code здесь не хранится и не показывается.</p>
      </section>
      <div class="card stack">
        <div class="notice success">Код проверки: <strong>${escapeHtml(toDisplayCode(vote.verification_code))}</strong></div>
        <div class="notice">Зафиксированный бюллетень:</div>
        <ol class="checklist">${lines}</ol>
        <div class="actions">
          <a class="button secondary" href="/verify/${election.id}">Проверить другой код</a>
          <a class="button secondary" href="/">На главную</a>
        </div>
      </div>
    `,
  );
}

export function renderProtocolPage(protocol: ProtocolResult): string {
  const resultRows = protocol.results
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.label)}</td>
          <td>${row.votes}</td>
        </tr>
      `,
    )
    .join("");

  const entryRows = protocol.entries
    .map(
      (entry) => `
        <tr>
          <td><code>${escapeHtml(toDisplayCode(entry.verificationCode))}</code></td>
          <td>${entry.selectedOptions.map((item) => escapeHtml(item)).join(", ") || "<span class='muted'>Пусто</span>"}</td>
        </tr>
      `,
    )
    .join("");

  return layout(
    `Протокол — ${protocol.election.title}`,
    `
      <section class="hero">
        <div class="eyebrow">Итоговый протокол</div>
        <h1>${escapeHtml(protocol.election.title)}</h1>
        <p>${escapeHtml(protocol.election.description || "Без описания")}</p>
      </section>

      <div class="kpis">
        <div class="card kpi"><span class="muted">Сгенерировано кодов</span><strong>${protocol.totalCodes}</strong></div>
        <div class="card kpi"><span class="muted">Использовано кодов</span><strong>${protocol.usedCodes}</strong></div>
        <div class="card kpi"><span class="muted">Бюллетеней</span><strong>${protocol.totalVotes}</strong></div>
      </div>

      <div class="grid two" style="margin-top: 18px;">
        <div class="card stack">
          <h2>Результаты</h2>
          <table>
            <thead>
              <tr><th>Кандидат</th><th>Голоса</th></tr>
            </thead>
            <tbody>${resultRows}</tbody>
          </table>
        </div>
        <div class="card stack">
          <h2>Метаданные</h2>
          <div class="checklist">
            <div>Тип: ${escapeHtml(protocol.election.type === "single" ? "Один вариант" : "Несколько вариантов")}</div>
            <div>Старт: ${escapeHtml(protocol.election.start_at || "не задан")}</div>
            <div>Окончание: ${escapeHtml(protocol.election.end_at || "не задано")}</div>
            <div>Статус: ${escapeHtml(protocol.election.status)}</div>
          </div>
          <div class="actions">
            <a class="button secondary" href="/admin/elections/${protocol.election.id}/export.json">Скачать JSON</a>
          </div>
        </div>
      </div>

      <div class="card stack" style="margin-top: 18px;">
        <h2>Протокол по кодам проверки</h2>
        <table>
          <thead>
            <tr><th>Код проверки</th><th>Бюллетень</th></tr>
          </thead>
          <tbody>${entryRows}</tbody>
        </table>
      </div>
    `,
  );
}
