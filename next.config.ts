import type { NextConfig } from "next";

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const normalizeMediaBackendUrl = (value: string): string => {
  const trimmed = trimTrailingSlash(value);
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === "https:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      parsed.protocol = "http:";
      return trimTrailingSlash(parsed.toString());
    }
    return trimTrailingSlash(parsed.toString());
  } catch {
    return trimmed;
  }
};

const nextConfig: NextConfig = {
  async rewrites() {
    const mediaBackendUrl = normalizeMediaBackendUrl(
      process.env.MEDIA_BACKEND_URL || "http://localhost:8787",
    );

    return [
      {
        source: "/api/merge-clips",
        destination: `${mediaBackendUrl}/api/merge-clips`,
      },
      {
        source: "/api/render-reel",
        destination: `${mediaBackendUrl}/api/render-reel`,
      },
      {
        source: "/api/clip-proxy",
        destination: `${mediaBackendUrl}/api/clip-proxy`,
      },
    ];
  },
};

export default nextConfig;
