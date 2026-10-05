import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native / Node-only modules are loaded at runtime by route handlers, never bundled.
  serverExternalPackages: ['better-sqlite3', '@abandonware/noble', 'ws'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Do not write AGENTS.md / CLAUDE.md into the project on `next dev`.
  agentRules: false,
  devIndicators: false,
};

export default nextConfig;
