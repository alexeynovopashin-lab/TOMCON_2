const CLIENT_ID = "809339045814-jjvh7mifdeu2llm5tnmvfqif92cnf8tk.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events";

// Справочная карточка студии для внешних каналов (шаг 2 TASK_LIGHT_PLAN_BRIDGE.md).
// Значения продублированы из index.html DEF.studio / DEF.halls вручную —
// у Worker'а нет доступа к localStorage PWA, где администратор их правит
// через настройки. Если адрес/телефон/составы залов поменяются в форме
// настроек TOMCOH_OS, эти константы тоже придётся обновить руками.
const STUDIO_CARD = {
  id: "tomson",
  name: "Фотостудия Томсон",
  address: "Ул. Красноармейская, 101а",
  lat: 56.4621, lon: 84.9666,
  tel: "+79618878078",
  hourMin: 55,
  halls: [
    { id: "sphere", name: "Сфера" },
    { id: "edison", name: "Эдисон" },
    { id: "vegas", name: "Вегас" }
  ]
};

// Календари залов — те же id, что и в index.html CALENDAR_SETS. Пока
// "test": боевые календари ещё не заведены (ROADMAP, Этап 8). Обновить
// здесь и там синхронно при переключении на "live".
const HALL_CALENDARS = {
  sphere: "5cd94eec5d9e29ae224dd1d75f8e6d06ce2234570ed22aeb1011df2d996ee5f3@group.calendar.google.com",
  edison: "6f89fde3c9c8fb16463cae64d30e92f3f3b96a3cf9fe3784dcf6d8d7f5616c13@group.calendar.google.com",
  vegas:  "8a5d49e1c87dd7cd07e6ee9382732b9515df65b334de1558f3bf6028617ed975@group.calendar.google.com"
};
// Тот же часовой пояс, что в index.html CALENDAR_TZ ("Asia/Tomsk", без
// перехода на летнее время — смещение постоянно).
const STUDIO_TZ_OFFSET = "+07:00";

// Ключ сверки телефона — нормализатор Алексея (2026-09-03), российская
// ветка: у студии брони российские, разбирать два десятка стран незачем.
// Сравнивать нужно этим (telFull), а не appId: appId годится только для
// мобильных (шаг 5, метка контакта), а матч брони должен ловить и то, что
// appId отбросит.
function telDigits(v) { return String(v || "").replace(/\D/g, ""); }
function telFull(v) {
  const raw = String(v || "");
  const d = telDigits(raw);
  if (!d) return "";
  if (/^\s*\+/.test(raw)) return d;
  if (d.length > 2 && d.slice(0, 2) === "00") return d.slice(2);
  if (d.length === 11 && d[0] === "8") return "7" + d.slice(1);
  if (d.length === 10) return "7" + d;
  return d;
}
// ID делается только с мобильного: городской принадлежит месту, а не
// человеку (шаг 5). Используется для метки контакта в CONTACTS, не для
// матча брони — там нужен telFull целиком.
function appId(v) {
  const d = telFull(v);
  return (d.length === 11 && d[0] === "7" && d[1] === "9") ? "id" + d : "";
}

// Только источники, которым разрешено дёргать Worker: PWA студии на
// GitHub Pages и (когда появится) страница Light Plan. Никакого "*" —
// Worker обслуживает не только администратора, а любого, кто знает URL.
const ALLOWED_ORIGINS = [
  "https://alexeynovopashin-lab.github.io",
];

function cors(request) {
  const origin = request.headers.get("Origin");
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    // PATCH и DELETE нужны для изменения и удаления событий календаря.
    // Без них браузер отклоняет запрос на стадии preflight.
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Studio-Key",
  };
}

function json(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(request) }
  });
}

// Общий секрет для эндпоинтов, к которым обращается внешний код (не сам PWA
// студии через свою же сессию) — сейчас /calendar/*, дальше и /studio,
// /rent/*, /booking/match из шагов 2–3. Секрет задаётся через
// `wrangler secret put STUDIO_KEY`.
function hasValidStudioKey(request, env) {
  if (!env.STUDIO_KEY) return false;
  return request.headers.get("X-Studio-Key") === env.STUDIO_KEY;
}

/* ========== Продление аренды (шаг 3 TASK_LIGHT_PLAN_BRIDGE.md) ==========
   Брони живут только в localStorage PWA администратора — Worker их не
   видит и не хранит. Единственное внешнее представление брони — событие
   Google Calendar, поэтому bookingRef здесь всегда "calendarId:eventId":
   по нему при запросе на продление читается текущий конец брони (для
   answerBy), а сама правка брони (после подтверждения администратором)
   происходит в PWA обычным путём и сюда не попадает — только её результат
   (newEnd), чтобы Light Plan мог его увидеть через /rent/status. */

function parseBookingRef(ref) {
  const sep = typeof ref === "string" ? ref.indexOf(":") : -1;
  if (sep <= 0) return null;
  return { calendarId: ref.slice(0, sep), eventId: ref.slice(sep + 1) };
}

async function fetchCalendarEvent(env, calendarId, eventId) {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const event = await res.json();
  if (event.status === "cancelled") return null;
  return event;
}

/* Молчание — это отказ: запрос, на который не ответили до answerBy,
   считается expired независимо от того, что записано в KV. Никакого
   крона для этого не нужно — статус вычисляется при каждом чтении. */
function effectiveStatus(record) {
  if (record.status === "requested" && Date.now() > new Date(record.answerBy).getTime()) {
    return "expired";
  }
  return record.status;
}

async function handleRentExtend(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.bookingRef !== "string" || !Number.isFinite(body.minutes) || body.minutes <= 0) {
    return json({ error: "Bad request" }, 400, request);
  }
  const parsed = parseBookingRef(body.bookingRef);
  if (!parsed) return json({ error: "bookingRef must be \"calendarId:eventId\"" }, 400, request);

  const event = await fetchCalendarEvent(env, parsed.calendarId, parsed.eventId);
  if (!event) return json({ error: "Booking not found" }, 404, request);
  const answerBy = event.end?.dateTime || event.end?.date;
  if (!answerBy) return json({ error: "Booking has no end time" }, 400, request);

  const id = "rq_" + crypto.randomUUID().slice(0, 8);
  const record = {
    id,
    bookingRef: body.bookingRef,
    minutes: body.minutes,
    requestedAt: body.requestedAt || new Date().toISOString(),
    answerBy,
    status: "requested",
    newEnd: null
  };
  // Запись не нужна дольше конца дня брони — держим её в KV с запасом,
  // дальше Cloudflare подчистит сама.
  const ttlSeconds = Math.max(300, Math.floor((new Date(answerBy).getTime() - Date.now()) / 1000) + 86400);
  await env.RENT_REQUESTS.put(id, JSON.stringify(record), { expirationTtl: ttlSeconds });

  return json({ id, status: "requested", answerBy }, 200, request);
}

async function handleRentStatus(request, env, url) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id" }, 400, request);
  const raw = await env.RENT_REQUESTS.get(id);
  if (!raw) return json({ error: "Not found" }, 404, request);
  const record = JSON.parse(raw);
  return json({ status: effectiveStatus(record), newEnd: record.newEnd ?? null }, 200, request);
}

/* Опрашивается PWA студии, чтобы показать заявку рядом с бронью в дне —
   Worker не может достучаться до браузера администратора сам. */
async function handleRentPending(request, env) {
  const list = await env.RENT_REQUESTS.list({ prefix: "rq_" });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.RENT_REQUESTS.get(k.name);
    if (!raw) continue;
    const record = JSON.parse(raw);
    if (effectiveStatus(record) === "requested") {
      out.push({
        id: record.id,
        bookingRef: record.bookingRef,
        minutes: record.minutes,
        requestedAt: record.requestedAt,
        answerBy: record.answerBy
      });
    }
  }
  return json({ requests: out }, 200, request);
}

/* Ответ администратора. Саму бронь и событие Google это НЕ трогает —
   их правит PWA обычным путём (saveBooking → syncBookingToGoogle);
   сюда только приходит итог, чтобы Light Plan увидел его через
   /rent/status. */
async function handleRentRespond(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.id !== "string" || !["confirm", "decline"].includes(body.action)) {
    return json({ error: "Bad request" }, 400, request);
  }
  const raw = await env.RENT_REQUESTS.get(body.id);
  if (!raw) return json({ error: "Not found" }, 404, request);
  const record = JSON.parse(raw);
  const current = effectiveStatus(record);
  if (current !== "requested") {
    return json({ error: `Already ${current}` }, 409, request);
  }

  record.status = body.action === "confirm" ? "confirmed" : "declined";
  if (body.action === "confirm") record.newEnd = body.newEnd || null;
  await env.RENT_REQUESTS.put(body.id, JSON.stringify(record));

  return json({ id: record.id, status: record.status, newEnd: record.newEnd }, 200, request);
}

/* ========== Связь по номеру (шаг 4 TASK_LIGHT_PLAN_BRIDGE.md) ==========
   Единственный источник телефона у Worker'а — текст события Google Calendar
   (buildEventBody в index.html кладёт "Телефон: ..." в description). Своей
   базы броней у Worker'а нет и не будет — см. комментарий у bookingRefOf. */
function phoneFromDescription(description) {
  const m = /Телефон:\s*([^\n]+)/.exec(String(description || ""));
  return m ? telFull(m[1]) : "";
}

/* ========== Учёт клиентов (шаг 5 TASK_LIGHT_PLAN_BRIDGE.md) ==========
   Флаг ставится наблюдением, а не выводом из номера: пришёл match —
   "фотограф, есть LP", не пришёл — "неизвестно", а не "нет приложения".
   Роль (фотограф/клиент) тоже не выводится — её здесь просто негде взять,
   так что пишем только то, что реально наблюдали. UI поверх этой базы
   не строим: Алексей пока хочет только саму запись (2026-09-03). */
async function recordPhotographerObserved(env, phone) {
  const id = appId(phone);
  if (!id) return; // только мобильные — appId
  const raw = await env.CONTACTS.get(id);
  const record = raw ? JSON.parse(raw) : { personId: id, phone };
  if (!record.photographerLPSince) record.photographerLPSince = new Date().toISOString();
  record.photographerLP = true;
  await env.CONTACTS.put(id, JSON.stringify(record));
}

async function handleBookingMatch(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.date !== "string" || typeof body.from !== "string" ||
      typeof body.to !== "string" || !Array.isArray(body.phones)) {
    return json({ error: "Bad request" }, 400, request);
  }

  // Ничего из присланных ключей не логируем и не сохраняем — ни здесь,
  // ни при непопадании: несовпавший номер студии не принадлежит и не
  // должен у неё появиться (правило шага 4).
  const wanted = new Set(body.phones.map(telFull).filter(Boolean));
  if (!wanted.size) return json({ match: false }, 200, request);

  const timeMin = `${body.date}T${body.from}:00${STUDIO_TZ_OFFSET}`;
  const timeMax = `${body.date}T${body.to}:00${STUDIO_TZ_OFFSET}`;
  const token = await getAccessToken(env);

  for (const [hallId, calendarId] of Object.entries(HALL_CALENDARS)) {
    if (!calendarId) continue;
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
      `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const event of data.items || []) {
      if (event.status === "cancelled") continue;
      const phone = phoneFromDescription(event.description);
      if (phone && wanted.has(phone)) {
        await recordPhotographerObserved(env, phone);
        return json({
          match: true,
          bookingRef: `${calendarId}:${event.id}`,
          hallId,
          start: (event.start?.dateTime || "").slice(11, 16),
          end: (event.end?.dateTime || "").slice(11, 16)
        }, 200, request);
      }
    }
  }

  return json({ match: false }, 200, request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(request) });
    }

    try {
      if (url.pathname === "/login") {
        const redirectUri = `${url.origin}/callback`;
        const params = new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent"
        });
        return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
      }

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (!code) return json({ error: "No code" }, 400, request);

        const redirectUri = `${url.origin}/callback`;
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: env.CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: "authorization_code"
          })
        });

        const tokens = await tokenRes.json();
        if (tokens.error) return json(tokens, 400, request);

        if (tokens.refresh_token) {
          await env.TOKENS.put("refresh_token", tokens.refresh_token);
        }
        await env.TOKENS.put("access_token", tokens.access_token, {
          expirationTtl: (tokens.expires_in || 3600) - 60
        });

        const redirectTo = env.POST_AUTH_REDIRECT || "https://alexeynovopashin-lab.github.io/TOMCON_2/";
        return Response.redirect(redirectTo + "?google=connected", 302);
      }

      if (url.pathname === "/studio") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, request);
        if (!hasValidStudioKey(request, env)) {
          return json({ error: "Unauthorized" }, 401, request);
        }
        return json(STUDIO_CARD, 200, request);
      }

      if (url.pathname === "/rent/extend") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
        if (!hasValidStudioKey(request, env)) return json({ error: "Unauthorized" }, 401, request);
        return await handleRentExtend(request, env);
      }

      if (url.pathname === "/rent/status") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, request);
        if (!hasValidStudioKey(request, env)) return json({ error: "Unauthorized" }, 401, request);
        return await handleRentStatus(request, env, url);
      }

      if (url.pathname === "/rent/pending") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, request);
        if (!hasValidStudioKey(request, env)) return json({ error: "Unauthorized" }, 401, request);
        return await handleRentPending(request, env);
      }

      if (url.pathname === "/rent/respond") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
        if (!hasValidStudioKey(request, env)) return json({ error: "Unauthorized" }, 401, request);
        return await handleRentRespond(request, env);
      }

      if (url.pathname === "/booking/match") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
        if (!hasValidStudioKey(request, env)) return json({ error: "Unauthorized" }, 401, request);
        return await handleBookingMatch(request, env);
      }

      if (url.pathname.startsWith("/calendar/")) {
        if (!hasValidStudioKey(request, env)) {
          return json({ error: "Unauthorized" }, 401, request);
        }

        const token = await getAccessToken(env);
        const path = url.pathname.replace("/calendar", "");
        const target = `https://www.googleapis.com/calendar/v3${path}${url.search}`;

        const init = {
          method: request.method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        };

        if (request.method !== "GET" && request.method !== "HEAD") {
          init.body = await request.text();
        }

        const res = await fetch(target, init);
        const body = await res.text();

        return new Response(body, {
          status: res.status,
          headers: { "Content-Type": "application/json", ...cors(request) }
        });
      }

      return new Response("Tomson Auth Worker is running", { headers: cors(request) });
    } catch (err) {
      return json({ error: err.message }, 500, request);
    }
  }
};

async function getAccessToken(env) {
  let access = await env.TOKENS.get("access_token");
  if (access) return access;

  const refresh = await env.TOKENS.get("refresh_token");
  if (!refresh) throw new Error("Not authenticated. Open /login first");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token"
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);

  await env.TOKENS.put("access_token", data.access_token, {
    expirationTtl: (data.expires_in || 3600) - 60
  });

  return data.access_token;
}
