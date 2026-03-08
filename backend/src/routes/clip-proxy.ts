import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { Router } from "express";

const router = Router();
const allowedProtocols = new Set(["http:", "https:"]);

const pickHeader = (headers: Headers, key: string): string | null => {
  const value = headers.get(key);
  return value && value.trim().length > 0 ? value : null;
};

const fetchUpstream = async (
  targetUrl: string,
  baseHeaders: Headers,
  referer?: string,
): Promise<Response | null> => {
  const attempts: Array<{ withReferer: boolean; withRange: boolean }> = [
    { withReferer: true, withRange: true },
    { withReferer: false, withRange: true },
    { withReferer: true, withRange: false },
    { withReferer: false, withRange: false },
  ];

  for (const attempt of attempts) {
    const headers = new Headers(baseHeaders);
    if (!attempt.withRange) {
      headers.delete("range");
    }

    if (referer && attempt.withReferer) {
      try {
        const refererUrl = new URL(referer);
        if (allowedProtocols.has(refererUrl.protocol)) {
          headers.set("referer", refererUrl.toString());
          headers.set("origin", refererUrl.origin);
        }
      } catch {
        // ignore invalid referer
      }
    }

    try {
      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "follow",
      });
      if (upstream.ok || upstream.status === 206) return upstream;
    } catch {
      // try next strategy
    }
  }

  return null;
};

router.get("/api/clip-proxy", async (req, res) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
  const rawReferer = typeof req.query.referer === "string" ? req.query.referer : "";

  if (!rawUrl) {
    return res.status(400).json({ error: "url is required" });
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: "invalid url" });
  }

  if (!allowedProtocols.has(target.protocol)) {
    return res.status(400).json({ error: "unsupported protocol" });
  }

  const upstreamHeaders = new Headers({
    "user-agent": "Mozilla/5.0",
    accept: "*/*",
  });

  const range = typeof req.headers.range === "string" ? req.headers.range : "";
  if (range) upstreamHeaders.set("range", range);

  try {
    const upstream = await fetchUpstream(
      target.toString(),
      upstreamHeaders,
      rawReferer || undefined,
    );
    if (!upstream) {
      return res.status(502).json({ error: "unable to load clip from source" });
    }

    const contentType = pickHeader(upstream.headers, "content-type") ?? "video/mp4";

    res.status(upstream.status);
    res.setHeader("content-type", contentType);
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("cache-control", "no-store");

    const passthroughHeaders = [
      "content-length",
      "content-range",
      "etag",
      "last-modified",
    ] as const;

    for (const header of passthroughHeaders) {
      const value = pickHeader(upstream.headers, header);
      if (value) res.setHeader(header, value);
    }

    if (upstream.body) {
      Readable.fromWeb(
        upstream.body as unknown as NodeWebReadableStream<Uint8Array>,
      ).pipe(res);
      return;
    }

    const data = Buffer.from(await upstream.arrayBuffer());
    res.send(data);
  } catch {
    return res.status(502).json({ error: "clip proxy failed" });
  }
});

export default router;
