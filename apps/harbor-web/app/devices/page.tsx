"use client";

import { useEffect, useMemo, useState } from "react";
import { listAgents, listDevices, type Device, type HarborAgent } from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnGhost, Empty, Metric, PageHeader } from "../../components/ui";

function seenAt(ts: number | null): string {
  if (!ts) return "从未连接";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(ts).toLocaleString();
}

export default function DevicesPage() {
  const devices = usePoll(listDevices, 10_000);
  const agents = usePoll(listAgents, 10_000);
  const [origin, setOrigin] = useState("");
  const toast = useToast();
  useEffect(() => setOrigin(location.origin), []);

  const agentsByDevice = useMemo(() => {
    const grouped = new Map<string, HarborAgent[]>();
    for (const agent of agents.data ?? []) {
      grouped.set(agent.deviceId, [...(grouped.get(agent.deviceId) ?? []), agent]);
    }
    return grouped;
  }, [agents.data]);

  const setupCommand = `harbor daemon setup --server-url ${origin || "https://<harbor-server>"} --token <HARBOR_TOKEN> --device-name <name>`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setupCommand);
      toast("接入命令已复制，请替换 token 和设备名", "success");
    } catch (e) {
      toast(`复制失败：${e instanceof Error ? e.message : e}`, "error");
    }
  };

  const allDevices = devices.data ?? [];
  const online = allDevices.filter((d) => d.online).length;
  const providers = new Set(allDevices.flatMap((d) => Object.keys(d.capabilities.clis ?? {}))).size;

  return (
    <div className="page-enter mx-auto max-w-[1440px] p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Fleet overview"
        title="Devices"
        description="每台机器都由 harbord 实机探测能力；这里展示此刻真正能接单的 provider、模型和 Agent。"
        actions={
          <div className="flex gap-5 rounded-xl border border-line bg-panel/75 px-4 py-2.5 surface-shadow">
            <Metric label="Machines" value={allDevices.length} />
            <Metric label="Online" value={online} tone="good" />
            <Metric label="Providers" value={providers} />
          </div>
        }
      />

      <section className="surface-shadow mb-6 overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="grid md:grid-cols-[260px_1fr]">
          <div className="border-b border-line bg-accent-soft/60 p-5 md:border-b-0 md:border-r">
            <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-bold text-white">01</div>
            <h2 className="text-sm font-semibold">Bring a machine online</h2>
            <p className="mt-1.5 text-xs leading-5 text-dim">目标机器安装 Harbor CLI 后执行一次；用户级服务会自动启动并保持连接。</p>
          </div>
          <div className="min-w-0 p-5">
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-dim">Bootstrap command</div>
              <button className={btnGhost} onClick={copy}>复制命令</button>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-xl border border-white/5 bg-harbor px-4 py-3 text-[#b9d5cc] shadow-inner">
              <span className="select-none font-mono text-xs text-[#62cfb6]">$</span>
              <code className="min-w-0 overflow-x-auto whitespace-nowrap font-mono text-[11px] leading-5">{setupCommand}</code>
            </div>
          </div>
        </div>
      </section>

      {devices.error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-canceled">{devices.error}</div>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {allDevices.map((device) => (
          <DeviceCard key={device.id} device={device} agents={agentsByDevice.get(device.id) ?? []} />
        ))}
      </div>
      {allDevices.length === 0 && <Empty text="还没有设备——在目标机器执行上面的 daemon setup 命令" />}
    </div>
  );
}

function DeviceCard({ device, agents }: { device: Device; agents: HarborAgent[] }) {
  const providers = Object.entries(device.capabilities.clis ?? {}).filter(([name]) => name === "claude" || name === "codex");
  const endpoints = device.capabilities.endpoints ?? [];

  return (
    <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
      <div className={`h-1 ${device.online ? "bg-accent" : "bg-zinc-300"}`} />
      <div className="p-5">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border font-mono text-sm font-semibold ${device.online ? "border-emerald-200 bg-emerald-50 text-accent" : "border-line bg-bg text-dim"}`}>
              {device.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold tracking-tight">{device.name}</h2>
              <div className="mt-1 truncate font-mono text-[10px] text-dim" title={device.id}>{device.id}</div>
            </div>
          </div>
          <div className="text-right">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${device.online ? "border-emerald-200 bg-emerald-50 text-done" : "border-line bg-bg text-dim"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${device.online ? "bg-done" : "bg-zinc-400"}`} />
              {device.online ? "Online" : "Offline"}
            </span>
            <div className="mt-1.5 text-[10px] text-dim">seen {seenAt(device.lastSeenAt)}</div>
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <SectionTitle label="Runtime providers" value={providers.length} />
            <div className="space-y-2">
              {providers.map(([name, version]) => (
                <div key={name} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-bg/65 px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className={`grid h-7 w-7 place-items-center rounded-lg text-[11px] font-bold uppercase ${name === "claude" ? "bg-[#f2e7d7] text-[#9b5f25]" : "bg-accent-soft text-accent-strong"}`}>{name[0]}</span>
                    <span className="text-xs font-semibold capitalize">{name}</span>
                  </div>
                  <span className="max-w-[110px] truncate font-mono text-[10px] text-dim" title={String(version)}>{String(version)}</span>
                </div>
              ))}
              {providers.length === 0 && <div className="rounded-xl border border-dashed border-red-200 px-3 py-3 text-xs text-canceled">未检测到 claude / codex</div>}
            </div>
          </div>

          <div>
            <SectionTitle label="Assigned agents" value={agents.length} />
            <div className="space-y-2">
              {agents.map((agent) => (
                <div key={agent.id} className="flex items-center justify-between rounded-xl border border-line bg-bg/65 px-3 py-2.5 text-xs">
                  <span className="min-w-0 truncate font-medium">{agent.name}</span>
                  <span className="ml-2 rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] text-dim">{agent.backend}</span>
                </div>
              ))}
              {agents.length === 0 && <div className="rounded-xl border border-dashed border-line px-3 py-3 text-xs text-dim">No agent assigned</div>}
            </div>
          </div>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <SectionTitle label="Claude endpoints" value={endpoints.length} />
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
            {endpoints.map((endpoint) => (
              <span key={endpoint} className="rounded-md border border-line bg-white px-2 py-1 font-mono text-[10px] text-dim">{endpoint}</span>
            ))}
            {endpoints.length === 0 && <span className="text-xs text-dim">未上报 endpoints.yaml 模型</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionTitle({ label, value }: { label: string; value: number }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-dim">{label}</div>
      <div className="font-mono text-[10px] text-dim">{String(value).padStart(2, "0")}</div>
    </div>
  );
}
