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
  // The Gmail OAuth callback URL carries a one-time authorization code in its
  // query string; keep it out of the dev request log.
  logging: {
    incomingRequests: {
      ignore: [/\/api\/gmail\/oauth\/callback/],
    },
  },
};

export default nextConfig;
