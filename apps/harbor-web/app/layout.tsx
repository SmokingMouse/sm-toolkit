import type { Metadata } from "next";
import { Shell } from "../components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Harbor",
  description: "个人多设备 Agent 调度平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
