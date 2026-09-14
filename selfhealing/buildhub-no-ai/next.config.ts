import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Scope Turbopack's file watcher + resolver to this project directory.
  // Without this, Next.js walks up past the workspace and finds
  // /home/dharshan/package-lock.json, then tries to watch the entire home
  // directory tree ("OS file watch limit reached" + "ignored package-lock"
  // warning). Localhost-only demo; no behavior change to the app itself.
  outputFileTracingRoot: __dirname,
  turbopack: {
    root: __dirname,
  },
  // Dev-only. The comparison demo is accessed over loopback by both
  // `localhost` and `127.0.0.1`; Next blocks dev resources from non-localhost
  // origins unless explicitly allowed (see BLOCKED_ORIGIN "127.0.0.1").
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
