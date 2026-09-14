import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Scope Turbopack's file watcher + resolver to this project directory.
  // Same root-cause as buildhub-no-ai: without this, Next.js walks up past
  // the workspace to /home/dharshan/package-lock.json ("ignored
  // package-lock" warning) and widens the watch scope. No app behavior change.
  outputFileTracingRoot: __dirname,
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
