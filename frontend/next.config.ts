import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Pin the workspace root to this app so Turbopack stops warning about the
// multiple lockfiles higher up the tree (repo root + ~/pnpm-lock.yaml).
const root = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: { root },
};

export default nextConfig;
