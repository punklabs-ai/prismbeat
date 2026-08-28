const ALLOWED_ORIGINS = new Set([
  "https://prismbeat.app",
  "https://www.prismbeat.app",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
]);

const ALLOWED_TURNSTILE_HOSTNAMES = new Set([
  "prismbeat.app",
  "www.prismbeat.app",
]);

type WorkerEnv = Cloudflare.Env & {
  TURNSTILE_SECRET_KEY: string;
};

const TOPICS = new Set([
  "Installation and setup",
  "Spotify controls",
  "Visualisers",
  "Stream Deck hardware",
  "macOS",
  "Windows",
  "Bug report",
  "Feature request",
  "Installation or update",
  "Other",
]);

type SupportRequest = {
  name: string;
  email: string;
  topic: string;
  message: string;
  company: string;
  turnstileToken: string;
};

type TurnstileResult = {
  success?: boolean;
  hostname?: string;
  action?: string;
};

function jsonResponse(body: Record<string, string | boolean>, status: number, origin: string | null): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  });

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  return Response.json(body, { status, headers });
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readSupportRequest(value: unknown): SupportRequest | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const request = {
    name: textField(record.name),
    email: textField(record.email).toLowerCase(),
    topic: textField(record.topic),
    message: textField(record.message),
    company: textField(record.company),
    turnstileToken: textField(record.turnstileToken),
  };

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const valid =
    request.name.length >= 2 && request.name.length <= 80 &&
    request.email.length <= 254 && emailPattern.test(request.email) &&
    TOPICS.has(request.topic) &&
    request.message.length >= 10 && request.message.length <= 4000 &&
    request.company.length <= 120 &&
    request.turnstileToken.length > 0 && request.turnstileToken.length <= 2048;

  return valid ? request : null;
}

async function verifyTurnstile(
  token: string,
  secret: string,
  clientAddress: string,
  requestId: string,
): Promise<boolean> {
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  body.set("idempotency_key", requestId);
  if (clientAddress !== "unknown") body.set("remoteip", clientAddress);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  if (!response.ok) return false;

  const result = await response.json<TurnstileResult>();
  return result.success === true &&
    result.action === "support" &&
    typeof result.hostname === "string" &&
    ALLOWED_TURNSTILE_HOSTNAMES.has(result.hostname);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const requestId = crypto.randomUUID();
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        return jsonResponse({ ok: false, error: "Origin not allowed." }, 403, origin);
      }

      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    }

    if (url.pathname !== "/support" || request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Not found." }, 404, origin);
    }

    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ ok: false, error: "Origin not allowed." }, 403, origin);
    }

    const clientAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const ipLimit = await env.IP_RATE_LIMITER.limit({ key: clientAddress });
    if (!ipLimit.success) {
      return jsonResponse({ ok: false, error: "Too many requests. Please try again shortly." }, 429, origin);
    }

    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (contentLength > 32_768) {
      return jsonResponse({ ok: false, error: "Message is too large." }, 413, origin);
    }

    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
      return jsonResponse({ ok: false, error: "Expected JSON." }, 415, origin);
    }

    try {
      const payload: unknown = await request.json();
      const supportRequest = readSupportRequest(payload);

      if (!supportRequest) {
        return jsonResponse({ ok: false, error: "Please check the form and try again." }, 400, origin);
      }

      if (supportRequest.company) {
        return jsonResponse({ ok: true }, 200, origin);
      }

      const turnstileValid = await verifyTurnstile(
        supportRequest.turnstileToken,
        env.TURNSTILE_SECRET_KEY,
        clientAddress,
        requestId,
      );
      if (!turnstileValid) {
        return jsonResponse({ ok: false, error: "Please verify that you are human and try again." }, 400, origin);
      }

      const emailLimit = await env.EMAIL_RATE_LIMITER.limit({ key: supportRequest.email });
      if (!emailLimit.success) {
        return jsonResponse({ ok: false, error: "Too many requests. Please try again shortly." }, 429, origin);
      }

      const safeName = escapeHtml(supportRequest.name);
      const safeEmail = escapeHtml(supportRequest.email);
      const safeTopic = escapeHtml(supportRequest.topic);
      const safeMessage = escapeHtml(supportRequest.message).replaceAll("\n", "<br />");

      await env.EMAIL.send({
        to: "hello@prismbeat.app",
        from: { email: "support-form@prismbeat.app", name: "PrismBeat Support" },
        replyTo: { email: supportRequest.email, name: supportRequest.name },
        subject: `[PrismBeat Support] ${supportRequest.topic}`,
        text: [
          `Name: ${supportRequest.name}`,
          `Email: ${supportRequest.email}`,
          `Topic: ${supportRequest.topic}`,
          `Request ID: ${requestId}`,
          "",
          supportRequest.message,
        ].join("\n"),
        html: `
          <h2>New PrismBeat support request</h2>
          <p><strong>Name:</strong> ${safeName}<br />
          <strong>Email:</strong> ${safeEmail}<br />
          <strong>Topic:</strong> ${safeTopic}<br />
          <strong>Request ID:</strong> ${requestId}</p>
          <p>${safeMessage}</p>
        `,
      });

      return jsonResponse({ ok: true }, 200, origin);
    } catch (error) {
      console.error(JSON.stringify({
        message: "support request failed",
        requestId,
        error: error instanceof Error ? error.message : "Unknown error",
      }));
      return jsonResponse({ ok: false, error: "We could not send your message. Please try again." }, 500, origin);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
