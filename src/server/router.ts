import { handleHook } from "../hooks/handler.ts";
import type { Service } from "../service/service.ts";
import { ServiceError } from "../service/types.ts";

const MAX_BODY_BYTES = 1 * 1024 * 1024;

interface Ctx {
  service: Service;
  version: string;
  startedAt: number;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: code, message });
}

async function readJsonBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    const err = new ServiceError(
      "unsupported_media_type",
      "content-type must be application/json",
      415,
    );
    throw err;
  }
  const lenHeader = req.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    throw new ServiceError("payload_too_large", "request body exceeds 1 MiB", 413);
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ServiceError("payload_too_large", "request body exceeds 1 MiB", 413);
  }
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError("invalid_json", "request body is not valid JSON");
  }
}

export async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  try {
    if (path === "/" && method === "GET") {
      const uptimeSeconds = Math.floor((Date.now() - ctx.startedAt) / 1000);
      return jsonResponse(200, { status: "ok", version: ctx.version, uptimeSeconds });
    }

    if (path === "/events" && method === "POST") {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const result = ctx.service.publishEvent({
        source: body.source as string,
        type: body.type as string,
        data: body.data,
        time: body.time as string | undefined,
        id: body.id as string | undefined,
        specversion: body.specversion as string | undefined,
        datacontenttype: body.datacontenttype as string | undefined,
      });
      return jsonResponse(result.created ? 201 : 200, result.event);
    }

    if (path === "/events" && method === "GET") {
      const limitStr = url.searchParams.get("limit");
      const offsetStr = url.searchParams.get("offset");
      const events = ctx.service.queryEvents({
        type: url.searchParams.get("type") ?? undefined,
        source: url.searchParams.get("source") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
        until: url.searchParams.get("until") ?? undefined,
        limit: limitStr !== null ? Number(limitStr) : undefined,
        offset: offsetStr !== null ? Number(offsetStr) : undefined,
        order: (url.searchParams.get("order") as "asc" | "desc" | null) ?? undefined,
      });
      return jsonResponse(200, { events });
    }

    const pendingMatch = /^\/events\/pending\/([^/]+)$/.exec(path);
    if (pendingMatch && method === "GET") {
      const sessionId = decodeURIComponent(pendingMatch[1] as string);
      const events = ctx.service.getPendingEvents(
        sessionId,
        url.searchParams.get("since") ?? undefined,
      );
      return jsonResponse(200, { events });
    }

    const claimMatch = /^\/events\/pending\/([^/]+)\/claim$/.exec(path);
    if (claimMatch && method === "POST") {
      const sessionId = decodeURIComponent(claimMatch[1] as string);
      const events = ctx.service.claimPendingEvents(sessionId);
      return jsonResponse(200, { events });
    }

    const hookMatch = /^\/hooks\/([^/]+)\/([^/]+)$/.exec(path);
    if (hookMatch && method === "POST") {
      const hookName = decodeURIComponent(hookMatch[1] as string);
      const sessionId = decodeURIComponent(hookMatch[2] as string);
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const result = handleHook(ctx.service, hookName, sessionId, body);
      if (result.status === 204) return new Response(null, { status: 204 });
      return jsonResponse(200, { additionalContext: result.additionalContext });
    }

    const subsMatch = /^\/sessions\/([^/]+)\/subscriptions$/.exec(path);
    if (subsMatch) {
      const sessionId = decodeURIComponent(subsMatch[1] as string);
      if (method === "GET") {
        return jsonResponse(200, { subscriptions: ctx.service.listSubscriptions(sessionId) });
      }
      if (method === "POST") {
        const body = (await readJsonBody(req)) as { pattern?: string };
        if (typeof body.pattern !== "string") {
          return errorResponse(400, "invalid_body", "pattern is required");
        }
        ctx.service.subscribe(sessionId, body.pattern);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        const pattern = url.searchParams.get("pattern");
        if (pattern === null) {
          return errorResponse(400, "invalid_query", "pattern query param is required");
        }
        ctx.service.unsubscribe(sessionId, pattern);
        return new Response(null, { status: 204 });
      }
    }

    const tagsMatch = /^\/sessions\/([^/]+)\/tags$/.exec(path);
    if (tagsMatch) {
      const sessionId = decodeURIComponent(tagsMatch[1] as string);
      if (method === "GET") {
        return jsonResponse(200, { tags: ctx.service.listTags(sessionId) });
      }
      if (method === "POST") {
        const body = (await readJsonBody(req)) as { tag?: string };
        if (typeof body.tag !== "string") {
          return errorResponse(400, "invalid_body", "tag is required");
        }
        ctx.service.tag(sessionId, body.tag);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        const tag = url.searchParams.get("tag");
        if (tag === null) {
          return errorResponse(400, "invalid_query", "tag query param is required");
        }
        ctx.service.untag(sessionId, tag);
        return new Response(null, { status: 204 });
      }
    }

    return errorResponse(404, "not_found", `no route for ${method} ${path}`);
  } catch (err) {
    if (err instanceof ServiceError) {
      return errorResponse(err.status, err.code, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(500, "internal_error", message);
  }
}

export function makeHandler(service: Service, version: string) {
  const ctx: Ctx = { service, version, startedAt: Date.now() };
  return (req: Request) => handle(req, ctx);
}
