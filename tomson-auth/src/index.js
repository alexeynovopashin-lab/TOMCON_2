const CLIENT_ID = "809339045814-jjvh7mifdeu2llm5tnmvfqif92cnf8tk.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    // PATCH и DELETE нужны для изменения и удаления событий календаря.
    // Без них браузер отклоняет запрос на стадии preflight.
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
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
        if (!code) return json({ error: "No code" }, 400);

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
        if (tokens.error) return json(tokens, 400);

        if (tokens.refresh_token) {
          await env.TOKENS.put("refresh_token", tokens.refresh_token);
        }
        await env.TOKENS.put("access_token", tokens.access_token, {
          expirationTtl: (tokens.expires_in || 3600) - 60
        });

        const redirectTo = env.POST_AUTH_REDIRECT || "https://alexeynovopashin-lab.github.io/TOMCON_2/";
        return Response.redirect(redirectTo + "?google=connected", 302);
      }

      if (url.pathname === "/token") {
        const token = await getAccessToken(env);
        return json({ access_token: token });
      }

      if (url.pathname.startsWith("/calendar/")) {
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
          headers: { "Content-Type": "application/json", ...cors() }
        });
      }

      return new Response("Tomson Auth Worker is running", { headers: cors() });
    } catch (err) {
      return json({ error: err.message }, 500);
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
