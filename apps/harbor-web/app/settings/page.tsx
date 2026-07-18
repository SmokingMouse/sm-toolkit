"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createLabel,
  createLarkBinding,
  createMember,
  createMemberToken,
  currentActor,
  deleteLarkBinding,
  getActiveWorkspace,
  getToken,
  health,
  listAgents,
  listLabels,
  listLarkBindings,
  listMembers,
  listMemberTokens,
  listRepositories,
  listScmEvents,
  listWorkspaces,
  promptBlockSettings,
  resetPromptBlock,
  revokeMemberToken,
  savePromptBlock,
  setActiveWorkspace,
  setToken,
  updateLarkBinding,
  updateMember,
  updateRepository,
  updateWorkspace,
  type CurrentActor,
  type HarborAgent,
  type HarborWorkspace,
  type IssueLabel,
  type LarkWorkspaceBinding,
  type PromptBlockConfig,
  type PromptBlockKey,
  type PromptSource,
  type RepositoryWithMounts,
  type ScmEvent,
  type WorkspaceApiToken,
  type WorkspaceMember,
  type WorkspaceRole,
} from "../../lib/api";
import { useToast } from "../../components/toast";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  Empty,
  Field,
  inputCls,
  PageHeader,
} from "../../components/ui";

type Tab = "general" | "members" | "integrations" | "prompts";
const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "general", label: "General", hint: "Workspace 与浏览器连接" },
  { key: "members", label: "Members", hint: "角色、状态与访问 token" },
  {
    key: "integrations",
    label: "Integrations",
    hint: "Codebase、Lark 与 Labels",
  },
  { key: "prompts", label: "Prompts", hint: "Context + event pipeline" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <div className="page-enter mx-auto max-w-[1440px] p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Control plane"
        title="Settings"
        description="Workspace 边界、成员权限、外部入口与 Prompt pipeline 的统一配置面。"
      />
      <div className="surface-shadow mb-5 flex gap-1 overflow-x-auto rounded-2xl border border-line bg-panel p-1.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`min-w-[150px] flex-1 rounded-xl px-4 py-3 text-left transition ${tab === item.key ? "bg-harbor text-white shadow-sm" : "hover:bg-bg"}`}
          >
            <span className="block text-xs font-semibold">{item.label}</span>
            <span
              className={`mt-1 block text-[10px] ${tab === item.key ? "text-white/55" : "text-dim"}`}
            >
              {item.hint}
            </span>
          </button>
        ))}
      </div>
      {tab === "general" && <GeneralPanel />}
      {tab === "members" && <MembersPanel />}
      {tab === "integrations" && <IntegrationsPanel />}
      {tab === "prompts" && <PromptsPanel />}
    </div>
  );
}

function GeneralPanel() {
  const toast = useToast();
  const [tok, setTok] = useState("");
  const [origin, setOrigin] = useState("");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [workspaces, setWorkspaces] = useState<HarborWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [actor, setActor] = useState<CurrentActor | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTok(getToken());
    setOrigin(location.origin);
    if (!getToken()) return;
    Promise.all([listWorkspaces(), currentActor(), health()])
      .then(([spaces, me]) => {
        setWorkspaces(spaces);
        setActor(me);
        setConnected(true);
        const id = getActiveWorkspace() || spaces[0]?.id || "";
        setWorkspaceId(id);
        const workspace = spaces.find((item) => item.id === id) ?? spaces[0];
        setName(workspace?.name ?? "");
        setDescription(workspace?.description ?? "");
      })
      .catch(() => setConnected(false));
  }, []);

  const selectWorkspace = (id: string) => {
    setWorkspaceId(id);
    const workspace = workspaces.find((item) => item.id === id);
    setName(workspace?.name ?? "");
    setDescription(workspace?.description ?? "");
  };
  const saveConnection = () => {
    setToken(tok.trim());
    toast("Token 已保存，仅存于浏览器 localStorage", "success");
    setTimeout(() => location.reload(), 500);
  };
  const activateWorkspace = () => {
    setActiveWorkspace(workspaceId);
    toast("Active Workspace 已切换，页面将重新加载", "success");
    setTimeout(() => location.reload(), 500);
  };
  const saveWorkspace = async () => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const updated = await updateWorkspace(workspaceId, {
        name: name.trim(),
        description: description.trim() || null,
      });
      setWorkspaces((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
      toast("Workspace 基本信息已保存", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[340px_1fr]">
      <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel xl:sticky xl:top-7">
        <div className="border-b border-line bg-harbor p-5 text-white">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.17em] text-white/40">
                Server connection
              </div>
              <h2 className="mt-1 text-base font-semibold">
                Harbor Control Plane
              </h2>
            </div>
            <Status connected={connected} />
          </div>
          <div className="mt-4 truncate rounded-lg border border-white/8 bg-black/15 px-3 py-2 font-mono text-[10px] text-white/55">
            {origin || "…"}
          </div>
        </div>
        <div className="p-5">
          <Field label="HARBOR_TOKEN">
            <input
              type="password"
              className={inputCls}
              value={tok}
              onChange={(event) => setTok(event.target.value)}
            />
          </Field>
          <p className="mt-2 text-[11px] leading-4 text-dim">
            Owner token 或 Workspace member token。只保存在当前浏览器。
          </p>
          <button className={`${btnPrimary} mt-5`} onClick={saveConnection}>
            保存 Token
          </button>
        </div>
      </section>
      <section className="surface-shadow rounded-2xl border border-line bg-panel p-6 max-sm:p-4">
        <SectionTitle
          eyebrow="Workspace boundary"
          title="Basic configuration"
          description="Workspace 隔离 Agent、Skill、Issue、Automation、Integration 与成员权限。"
        />
        {!workspaces.length ? (
          <Empty text="保存可用 Token 后加载 Workspace" />
        ) : (
          <>
            <div className="grid gap-x-5 md:grid-cols-2">
              <Field label="Active Workspace">
                <select
                  className={inputCls}
                  value={workspaceId}
                  onChange={(event) => selectWorkspace(event.target.value)}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name} · {workspace.slug}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Current actor">
                <div className={`${inputCls} flex items-center`}>
                  {actor?.kind === "system"
                    ? "Server owner token"
                    : `${actor?.member.name} · ${actor?.member.role}`}
                </div>
              </Field>
              <Field label="Name">
                <input
                  className={inputCls}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="Description">
                <input
                  className={inputCls}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="这个 Workspace 负责什么"
                />
              </Field>
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <button className={btnGhost} onClick={activateWorkspace}>
                切换 Workspace
              </button>
              <button
                className={btnPrimary}
                disabled={busy || !name.trim()}
                onClick={saveWorkspace}
              >
                {busy ? "保存中…" : "保存 Basic"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function MembersPanel() {
  const toast = useToast();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [tokens, setTokens] = useState<WorkspaceApiToken[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [rawToken, setRawToken] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    const [memberResult, tokenResult] = await Promise.allSettled([
      listMembers(),
      listMemberTokens(),
    ]);
    if (memberResult.status === "fulfilled") setMembers(memberResult.value);
    else
      toast(
        memberResult.reason instanceof Error
          ? memberResult.reason.message
          : String(memberResult.reason),
        "error",
      );
    if (tokenResult.status === "fulfilled") setTokens(tokenResult.value);
  };
  useEffect(() => {
    void reload();
  }, []);
  const add = async () => {
    setBusy(true);
    try {
      await createMember({
        name: name.trim(),
        email: email.trim() || undefined,
        role,
      });
      setName("");
      setEmail("");
      await reload();
      toast("Member 已添加", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const patchMember = async (
    member: WorkspaceMember,
    patch: { role?: WorkspaceRole; status?: WorkspaceMember["status"] },
  ) => {
    try {
      await updateMember(member.id, patch);
      await reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const issueToken = async (member: WorkspaceMember) => {
    try {
      const created = await createMemberToken(
        member.id,
        `${member.name} access`,
      );
      setRawToken(created.token);
      await reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[1fr_360px]">
      <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="border-b border-line p-5">
          <SectionTitle
            eyebrow="RBAC"
            title="Workspace members"
            description="Owner 管所有边界；Admin 配资源；Member 创建 Issue、Chat 和消息。"
          />
        </div>
        <div className="divide-y divide-line">
          {members.map((member) => (
            <div
              key={member.id}
              className="grid items-center gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_130px_130px_auto]"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  {member.name}
                </div>
                <div className="mt-1 truncate text-[10px] text-dim">
                  {member.email ||
                    `${member.externalProvider}:${member.externalId ?? "local"}`}
                </div>
              </div>
              <select
                className={`${inputCls} py-2 text-xs`}
                value={member.role}
                onChange={(event) =>
                  void patchMember(member, {
                    role: event.target.value as WorkspaceRole,
                  })
                }
              >
                {["owner", "admin", "member"].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <select
                className={`${inputCls} py-2 text-xs`}
                value={member.status}
                onChange={(event) =>
                  void patchMember(member, {
                    status: event.target.value as WorkspaceMember["status"],
                  })
                }
              >
                {["active", "invited", "disabled"].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <button
                className={btnGhost}
                disabled={member.status !== "active"}
                onClick={() => void issueToken(member)}
              >
                New token
              </button>
            </div>
          ))}
        </div>
      </section>
      <div className="space-y-5">
        <section className="surface-shadow rounded-2xl border border-line bg-panel p-5">
          <SectionTitle
            eyebrow="Invite"
            title="Add member"
            description="本地部署不伪装企业通讯录；可绑定 Feishu/Codebase external id。"
          />
          <div className="mt-5">
            <Field label="Name">
              <input
                className={inputCls}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Email（optional）">
              <input
                className={inputCls}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Initial role">
              <select
                className={inputCls}
                value={role}
                onChange={(event) =>
                  setRole(event.target.value as WorkspaceRole)
                }
              >
                {["member", "admin", "owner"].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <button
              className={`${btnPrimary} w-full`}
              disabled={busy || !name.trim()}
              onClick={add}
            >
              Add member
            </button>
          </div>
        </section>
        <section className="surface-shadow rounded-2xl border border-line bg-panel p-5">
          <SectionTitle
            eyebrow="Access"
            title="API tokens"
            description="Token 只在创建时显示一次，可随时 revoke。"
          />
          {rawToken && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="text-[10px] font-bold uppercase text-amber-700">
                Copy now
              </div>
              <code className="mt-2 block break-all text-xs">{rawToken}</code>
              <button
                className={`${btnGhost} mt-3`}
                onClick={() => {
                  void navigator.clipboard.writeText(rawToken);
                  toast("Token 已复制", "success");
                }}
              >
                Copy token
              </button>
            </div>
          )}
          <div className="mt-4 space-y-2">
            {tokens
              .filter((token) => !token.revokedAt)
              .map((token) => (
                <div
                  key={token.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">
                      {token.label}
                    </div>
                    <div className="mt-1 text-[9px] text-dim">
                      {members.find((member) => member.id === token.memberId)
                        ?.name ?? token.memberId}
                    </div>
                  </div>
                  <button
                    className="text-[10px] font-semibold text-canceled"
                    onClick={async () => {
                      await revokeMemberToken(token.id);
                      await reload();
                    }}
                  >
                    Revoke
                  </button>
                </div>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function IntegrationsPanel() {
  const toast = useToast();
  const [repositories, setRepositories] = useState<RepositoryWithMounts[]>([]);
  const [agents, setAgents] = useState<HarborAgent[]>([]);
  const [bindings, setBindings] = useState<LarkWorkspaceBinding[]>([]);
  const [customBotConfigured, setCustomBotConfigured] = useState(false);
  const [events, setEvents] = useState<ScmEvent[]>([]);
  const [labels, setLabels] = useState<IssueLabel[]>([]);
  const reload = async () => {
    try {
      const [repos, roster, lark, scmEvents, issueLabels] = await Promise.all([
        listRepositories(),
        listAgents(),
        listLarkBindings(),
        listScmEvents(),
        listLabels(),
      ]);
      setRepositories(repos);
      setAgents(roster);
      setBindings(lark.bindings);
      setCustomBotConfigured(lark.customBotConfigured);
      setEvents(scmEvents);
      setLabels(issueLabels);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  return (
    <div className="space-y-5">
      <RepositoriesSection
        repositories={repositories}
        agents={agents}
        events={events}
        onChanged={reload}
      />
      <LarkSection
        bindings={bindings}
        agents={agents}
        customBotConfigured={customBotConfigured}
        onChanged={reload}
      />
      <LabelsSection labels={labels} onChanged={reload} />
    </div>
  );
}

function RepositoriesSection({
  repositories,
  agents,
  events,
  onChanged,
}: {
  repositories: RepositoryWithMounts[];
  agents: HarborAgent[];
  events: ScmEvent[];
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  return (
    <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="border-b border-line p-5">
        <SectionTitle
          eyebrow="SCM ingress + delivery"
          title="Repositories"
          description="Local 只负责 checkout；Codebase 同时接收 Issue/MR webhook，并驱动 Review、CI 与 merge 事实。"
        />
      </div>
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        {repositories.map((repository) => (
          <RepositoryIntegration
            key={repository.id}
            repository={repository}
            agents={agents}
            eventCount={
              events.filter((event) => event.repositoryId === repository.id)
                .length
            }
            onChanged={onChanged}
          />
        ))}
        {!repositories.length && (
          <Empty text="先在 Agents 页面创建并挂载 Repository" />
        )}
      </div>
      <div className="border-t border-line bg-bg/50 px-5 py-3 text-[11px] leading-5 text-dim">
        Codebase webhook 使用独立 <code>codebase.webhook_secret</code>，不复用
        HARBOR_TOKEN；事件先幂等落库，再投影 Issue / Delivery。
      </div>
    </section>
  );
}

function RepositoryIntegration({
  repository,
  agents,
  eventCount,
  onChanged,
}: {
  repository: RepositoryWithMounts;
  agents: HarborAgent[];
  eventCount: number;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [provider, setProvider] = useState(repository.scmProvider);
  const [scmRepository, setScmRepository] = useState(
    repository.scmRepository ?? "",
  );
  const [agentId, setAgentId] = useState(repository.scmAgentId ?? "");
  const [autoDispatch, setAutoDispatch] = useState(repository.scmAutoDispatch);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await updateRepository(repository.id, {
        scmProvider: provider,
        scmRepository: provider === "codebase" ? scmRepository.trim() : null,
        scmAgent: provider === "codebase" ? agentId || null : null,
        scmAutoDispatch: provider === "codebase" && autoDispatch,
      });
      await onChanged();
      toast(`${repository.name} SCM 配置已保存`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-2xl border border-line bg-white/55 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{repository.name}</div>
          <div className="mt-1 text-[10px] text-dim">
            {repository.mounts.length} mounts · {eventCount} SCM events
          </div>
        </div>
        <select
          className={`${inputCls} w-28 py-2 text-xs`}
          value={provider}
          onChange={(event) =>
            setProvider(event.target.value as "local" | "codebase")
          }
        >
          <option value="local">Local</option>
          <option value="codebase">Codebase</option>
        </select>
      </div>
      {provider === "codebase" && (
        <div className="mt-4">
          <Field label="Codebase repository path">
            <input
              className={`${inputCls} font-mono text-xs`}
              value={scmRepository}
              onChange={(event) => setScmRepository(event.target.value)}
              placeholder="org/project/repository"
            />
          </Field>
          <Field label="Ingress default Agent">
            <select
              className={inputCls}
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              <option value="">Sync only</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <label className="mb-4 flex items-start gap-3 rounded-xl border border-line bg-bg/60 p-3 text-xs">
            <input
              type="checkbox"
              checked={autoDispatch}
              onChange={(event) => setAutoDispatch(event.target.checked)}
            />
            <span>
              <b>Auto-dispatch</b>
              <span className="mt-1 block text-[10px] leading-4 text-dim">
                外部 Issue 或 @harbor 评论自动创建 Run；必须显式开启。
              </span>
            </span>
          </label>
          <div className="mb-4 rounded-lg bg-harbor px-3 py-2 font-mono text-[9px] leading-4 text-white/60">
            {typeof location === "undefined"
              ? ""
              : `${location.origin}/hooks/scm/codebase/${repository.id}`}
          </div>
        </div>
      )}
      <button
        className={`${btnPrimary} w-full`}
        disabled={busy || (provider === "codebase" && !scmRepository.trim())}
        onClick={save}
      >
        {busy ? "保存中…" : "Save repository integration"}
      </button>
    </div>
  );
}

function LarkSection({
  bindings,
  agents,
  customBotConfigured,
  onChanged,
}: {
  bindings: LarkWorkspaceBinding[];
  agents: HarborAgent[];
  customBotConfigured: boolean;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [chatId, setChatId] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [botMode, setBotMode] = useState<"global" | "custom">("global");
  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agents, agentId]);
  const add = async () => {
    try {
      await createLarkBinding({
        chatId: chatId.trim(),
        defaultAgent: agentId,
        responseMode: "thread",
        listenMode: "mention",
        botMode,
      });
      setChatId("");
      await onChanged();
      toast("Lark 群已绑定", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  return (
    <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="border-b border-line p-5">
        <SectionTitle
          eyebrow="Lark ingress"
          title="Workspace group bindings"
          description="群消息映射 Chat/Issue；引用续原会话，附件随 Run 下发，结果按 thread 或新消息回流。"
        />
      </div>
      <div className="grid gap-5 p-5 xl:grid-cols-[1fr_330px]">
        <div className="space-y-3">
          {bindings.map((binding) => (
            <div
              key={binding.id}
              className="grid items-center gap-3 rounded-xl border border-line bg-white/55 p-3 md:grid-cols-[minmax(0,1fr)_130px_120px_90px_auto]"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-semibold">
                  {binding.chatId}
                </div>
                <select
                  className="mt-1 border-0 bg-transparent p-0 text-[9px] uppercase text-dim"
                  value={binding.botMode}
                  onChange={async (event) => {
                    await updateLarkBinding(binding.id, {
                      botMode: event.target.value,
                    });
                    await onChanged();
                  }}
                >
                  <option value="global">global bot</option>
                  <option value="custom" disabled={!customBotConfigured}>
                    custom bot
                  </option>
                </select>
              </div>
              <select
                className={`${inputCls} py-2 text-xs`}
                value={binding.defaultAgentId}
                onChange={async (event) => {
                  await updateLarkBinding(binding.id, {
                    defaultAgent: event.target.value,
                  });
                  await onChanged();
                }}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <select
                className={`${inputCls} py-2 text-xs`}
                value={binding.listenMode}
                onChange={async (event) => {
                  await updateLarkBinding(binding.id, {
                    listenMode: event.target.value,
                  });
                  await onChanged();
                }}
              >
                <option value="mention">Mention</option>
                <option value="all">All</option>
              </select>
              <select
                className={`${inputCls} py-2 text-xs`}
                value={binding.responseMode}
                onChange={async (event) => {
                  await updateLarkBinding(binding.id, {
                    responseMode: event.target.value,
                  });
                  await onChanged();
                }}
              >
                <option value="thread">Thread</option>
                <option value="message">Message</option>
              </select>
              <button
                className={btnDanger}
                onClick={async () => {
                  if (!confirm("删除这个 Lark 群绑定？")) return;
                  await deleteLarkBinding(binding.id);
                  await onChanged();
                }}
              >
                删除
              </button>
            </div>
          ))}
          {!bindings.length && <Empty text="还没有绑定 Workspace 群" />}
        </div>
        <div className="rounded-xl border border-accent/20 bg-accent-soft/30 p-4">
          <div className="text-xs font-semibold">Bind a group</div>
          <div className="mt-4">
            <Field label="Lark chat_id">
              <input
                className={`${inputCls} font-mono text-xs`}
                value={chatId}
                onChange={(event) => setChatId(event.target.value)}
                placeholder="oc_xxx"
              />
            </Field>
            <Field label="Default Agent">
              <select
                className={inputCls}
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Bot profile">
              <select
                className={inputCls}
                value={botMode}
                onChange={(event) =>
                  setBotMode(event.target.value as "global" | "custom")
                }
              >
                <option value="global">Global Bot</option>
                <option value="custom" disabled={!customBotConfigured}>
                  Workspace custom Bot
                </option>
              </select>
              <p className="mt-2 text-[10px] leading-4 text-dim">
                {customBotConfigured
                  ? "Custom profile 已从 server 配置加载。"
                  : "在 ~/.harbor.yaml 的 feishu.custom_bots 中配置后可选。"}
              </p>
            </Field>
            <button
              className={`${btnPrimary} w-full`}
              disabled={!chatId.trim() || !agentId}
              onClick={add}
            >
              Bind group
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function LabelsSection({
  labels,
  onChanged,
}: {
  labels: IssueLabel[];
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#75817b");
  const add = async () => {
    try {
      await createLabel({ name: name.trim(), color });
      setName("");
      await onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  return (
    <section className="surface-shadow rounded-2xl border border-line bg-panel p-5">
      <SectionTitle
        eyebrow="Issue metadata"
        title="Labels"
        description="Owner、labels 与 mentions 都属于 Workspace，不跨边界复用。"
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {labels.map((label) => (
          <span
            key={label.id}
            className="rounded-full border px-3 py-1 text-xs font-medium"
            style={{
              borderColor: `${label.color}66`,
              color: label.color,
              backgroundColor: `${label.color}12`,
            }}
          >
            {label.name}
          </span>
        ))}
      </div>
      <div className="mt-5 flex max-w-lg gap-2">
        <input
          className={inputCls}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="label name"
        />
        <input
          type="color"
          className="h-11 w-14 rounded-xl border border-line bg-white p-1"
          value={color}
          onChange={(event) => setColor(event.target.value)}
        />
        <button className={btnPrimary} disabled={!name.trim()} onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}

const SOURCE_ORDER: PromptSource[] = ["issue", "chat", "automation"];
function PromptsPanel() {
  const toast = useToast();
  const [blocks, setBlocks] = useState<PromptBlockConfig[]>([]);
  const [blockKey, setBlockKey] = useState<PromptBlockKey>(
    "session.issue.context",
  );
  const [enabled, setEnabled] = useState(true);
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    promptBlockSettings()
      .then((data) => {
        setBlocks(data.blocks);
        const block =
          data.blocks.find((item) => item.key === blockKey) ?? data.blocks[0];
        if (block) choose(block);
      })
      .catch((error) =>
        toast(error instanceof Error ? error.message : String(error), "error"),
      );
  }, []);
  const current = blocks.find((block) => block.key === blockKey);
  const choose = (block: PromptBlockConfig) => {
    setBlockKey(block.key);
    setEnabled(block.enabled);
    setTemplate(block.template);
  };
  const replace = (block: PromptBlockConfig) => {
    setBlocks((items) =>
      items.map((item) => (item.key === block.key ? block : item)),
    );
    choose(block);
  };
  const save = async () => {
    setBusy(true);
    try {
      replace(await savePromptBlock({ key: blockKey, enabled, template }));
      toast("Prompt block 已保存", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="border-b border-line p-5">
        <SectionTitle
          eyebrow="Prompt pipeline"
          title="Context + event blocks"
          description="原始 prompt 原样落库；dispatch 时按触发原因组合稳定 context 与当前 event。"
        />
      </div>
      {!current ? (
        <div className="p-6">
          <Empty text="无法加载 Prompt blocks" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 border-b border-line bg-bg/55 p-4 md:grid-cols-3">
            {SOURCE_ORDER.map((source) => (
              <div
                key={source}
                className="rounded-xl border border-line bg-panel p-3"
              >
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.13em] text-dim">
                  {source}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {blocks
                    .filter((block) => block.source === source)
                    .map((block) => (
                      <button
                        key={block.key}
                        onClick={() => choose(block)}
                        className={`rounded-lg border px-3 py-2 text-xs font-semibold ${block.key === blockKey ? "border-harbor bg-harbor text-white" : "border-line bg-bg text-dim"}`}
                      >
                        {block.label}
                        {!block.isDefault ? " ·" : ""}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
          <div className="p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">
                    {current.label} prompt
                  </h3>
                  <code className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-dim">
                    {current.key}
                  </code>
                </div>
                <p className="mt-1 text-xs text-dim">{current.description}</p>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />{" "}
                Enabled
              </label>
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_290px]">
              <textarea
                className={`${inputCls} min-h-[520px] resize-y font-mono text-[11px] leading-5`}
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
                spellCheck={false}
              />
              <aside>
                <div className="text-xs font-semibold">Variables</div>
                <div className="mt-3 max-h-[520px] space-y-2 overflow-y-auto">
                  {current.variables.map((variable) => (
                    <button
                      key={variable.name}
                      onClick={async () => {
                        await navigator.clipboard.writeText(
                          `{{${variable.name}}}`,
                        );
                        toast("变量已复制", "success");
                      }}
                      className="block w-full rounded-lg border border-line bg-bg px-3 py-2 text-left"
                    >
                      <code className="break-all text-[11px]">{`{{${variable.name}}}`}</code>
                      <span className="mt-1 block text-[10px] leading-4 text-dim">
                        {variable.description}
                      </span>
                    </button>
                  ))}
                </div>
              </aside>
            </div>
            <div className="mt-5 flex gap-2 border-t border-line pt-4">
              <button className={btnPrimary} disabled={busy} onClick={save}>
                {busy ? "保存中…" : "保存 Block"}
              </button>
              <button
                className={btnGhost}
                disabled={busy || current.isDefault}
                onClick={async () => {
                  if (confirm("恢复默认 Prompt block？"))
                    replace(await resetPromptBlock(blockKey));
                }}
              >
                恢复默认
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Status({ connected }: { connected: boolean | null }) {
  return (
    <span
      className={`rounded-full border px-2 py-1 text-[10px] font-bold uppercase ${connected ? "border-emerald-300/20 bg-emerald-300/10 text-[#82d8c5]" : "border-white/10 text-white/40"}`}
    >
      {connected ? "Online" : connected === false ? "Offline" : "Unknown"}
    </span>
  );
}
function SectionTitle({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.17em] text-accent">
        {eyebrow}
      </div>
      <h2 className="mt-1 text-base font-semibold">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-dim">{description}</p>
    </div>
  );
}
