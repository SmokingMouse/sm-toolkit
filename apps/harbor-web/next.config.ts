/**
 * 静态导出（out/ 由 harbor-server 单进程 serve）；纯 CSR，Next 只当 bundler 用。
 * dev 期 rewrites 把 /api 代理到本机 harbor-server 免 CORS——只在 dev phase 挂，
 * 避免 `output: export` 下 build 报 rewrites 不支持。
 */
import { join } from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function config(phase: string): NextConfig {
  return {
    output: "export",
    images: { unoptimized: true },
    // 家目录散落 lockfile 会让 next 猜错 workspace 根
    outputFileTracingRoot: join(import.meta.dirname, "../.."),
    ...(phase === PHASE_DEVELOPMENT_SERVER
      ? {
          output: undefined,
          rewrites: async () => [
            { source: "/api/:path*", destination: "http://127.0.0.1:7777/api/:path*" },
          ],
        }
      : {}),
  };
}
