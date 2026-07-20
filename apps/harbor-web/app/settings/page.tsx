"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useEffect, useMemo, useState } from "react";
import {
  beginPasskeyRegistration,
  beginGitHubInstallation,
  beginGitHubLink,
  createInvitation,
  createLabel,
  createLarkBinding,
  createPersonalAccessToken,
  currentActor,
  disconnectGitHubInstallation,
  deleteLarkBinding,
  finishPasskeyRegistration,
  getActiveWorkspace,
  health,
  getGitHubIntegration,
  listAgents,
  listAuthIdentities,
  listInvitations,
  listLabels,
  listLarkBindings,
  listMembers,
  listPasskeys,
  listPersonalAccessTokens,
  listRepositories,
  listScmEvents,
  listWorkspaces,
  promptBlockSettings,
  resetPromptBlock,
  revokeInvitation,
  revokePersonalAccessToken,
  savePromptBlock,
  setActiveWorkspace,
  syncGitHubInstallation,
  updateLarkBinding,
  updateMember,
  updateRepository,
  updateWorkspace,
  type CurrentActor,
  type AuthIdentity,
  type GitHubIntegrationView,
  type HarborAgent,
  type HarborWorkspace,
  type IssueLabel,
  type LarkWorkspaceBinding,
  type PasskeyCredential,
  type PersonalAccessToken,
  type PromptBlockConfig,
  type PromptBlockKey,
  type PromptSource,
  type RepositoryWithMounts,
  type ScmEvent,
  type WorkspaceInvitation,
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

type Tab = "general" | "account" | "members" | "integrations" | "prompts";
const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "general", label: "General", hint: "Workspace 基本信息" },
  { key: "account", label: "Account", hint: "GitHub、Passkeys 与 PAT" },
  { key: "members", label: "Members", hint: "角色、状态与邀请" },
  {
    key: "integrations",
    label: "Integrations",
    hint: "GitHub、Codebase、Lark 与 Labels",
  },
  { key: "prompts", label: "Prompts", hint: "Context + event pipeline" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("general");
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("tab") as Tab | null;
    if (requested && TABS.some((item) => item.key === requested)) setTab(requested);
  }, []);
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
      {tab === "account" && <AccountPanel />}
      {tab === "members" && <MembersPanel />}
      {tab === "integrations" && <IntegrationsPanel />}
      {tab === "prompts" && <PromptsPanel />}
    </div>
  );
}

function GeneralPanel() {
  const toast = useToast();
  const [origin, setOrigin] = useState("");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [workspaces, setWorkspaces] = useState<HarborWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [actor, setActor] = useState<CurrentActor | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOrigin(location.origin);
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
          <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-dim">Current principal</div>
          <div className="mt-2 text-sm font-semibold">
            {actor?.kind === "account" ? actor.account.displayName : actor?.kind === "system" ? "System break-glass" : "Loading…"}
          </div>
          <div className="mt-1 break-all font-mono text-[10px] text-dim">
            {actor?.kind === "account" ? actor.account.id : "HARBOR_TOKEN compatibility gate"}
          </div>
          <p className="mt-4 border-t border-line pt-4 text-[11px] leading-5 text-dim">
            Browser access uses an HttpOnly Session cookie. Harbor 不再把长期凭证写入 localStorage。
          </p>
        </div>
      </section>
      <section className="surface-shadow rounded-2xl border border-line bg-panel p-6 max-sm:p-4">
        <SectionTitle
          eyebrow="Workspace boundary"
          title="Basic configuration"
          description="Workspace 隔离 Agent、Skill、Issue、Automation、Integration 与成员权限。"
        />
        {!workspaces.length ? (
          <Empty text="当前 Account 没有 active Workspace Membership" />
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
                    ? "System break-glass"
                    : actor?.kind === "account"
                      ? `${actor.account.displayName} · ${actor.credential}`
                      : "Loading…"}
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

type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];

function AccountPanel() {
  const toast = useToast();
  const [actor, setActor] = useState<CurrentActor | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyCredential[]>([]);
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [identities, setIdentities] = useState<AuthIdentity[]>([]);
  const [workspaces, setWorkspaces] = useState<HarborWorkspace[]>([]);
  const [passkeyLabel, setPasskeyLabel] = useState("");
  const [tokenLabel, setTokenLabel] = useState("CLI access");
  const [tokenWorkspace, setTokenWorkspace] = useState("");
  const [rawToken, setRawToken] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const [me, keys, pats, spaces, linkedIdentities] = await Promise.all([
      currentActor(), listPasskeys(), listPersonalAccessTokens(), listWorkspaces(), listAuthIdentities(),
    ]);
    setActor(me);
    setPasskeys(keys);
    setTokens(pats);
    setWorkspaces(spaces);
    setIdentities(linkedIdentities);
    setTokenWorkspace((current) => current || getActiveWorkspace() || spaces[0]?.id || "");
  };

  useEffect(() => {
    void reload().catch((error) => toast(error instanceof Error ? error.message : String(error), "error"));
    const params = new URLSearchParams(location.search);
    const githubError = params.get("github_error");
    if (githubError) toast(githubError, "error");
    else if (params.get("github") === "linked") toast("GitHub identity 已绑定", "success");
  }, []);

  const addPasskey = async () => {
    setBusy(true);
    try {
      const options = await beginPasskeyRegistration() as RegistrationOptions;
      const response = await startRegistration({ optionsJSON: options });
      await finishPasskeyRegistration(response, passkeyLabel.trim() || undefined);
      setPasskeyLabel("");
      await reload();
      toast("Passkey 已绑定", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const issuePat = async () => {
    setBusy(true);
    try {
      const created = await createPersonalAccessToken({
        label: tokenLabel.trim() || "CLI access",
        workspaceId: tokenWorkspace || null,
        scopes: ["workspace:read", "workspace:write", "agent:run"],
      });
      setRawToken(created.token);
      await reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const linkGitHub = async () => {
    setBusy(true);
    try {
      const started = await beginGitHubLink();
      location.assign(started.url);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
      setBusy(false);
    }
  };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[1fr_390px]">
      <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="border-b border-line p-5">
          <SectionTitle eyebrow="WebAuthn" title="Passkeys" description="Discoverable credential；RP ID 与 allowed origin 由 HARBOR_PUBLIC_URL 固定。" />
        </div>
        <div className="divide-y divide-line">
          {passkeys.filter((key) => !key.revokedAt).map((key) => (
            <div key={key.id} className="flex items-center gap-4 px-5 py-4">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent-soft text-lg text-accent">⌁</span>
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{key.label || "Passkey"}</div><div className="mt-1 text-[10px] text-dim">Added {new Date(key.createdAt).toLocaleDateString()} · {key.lastUsedAt ? `used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "not used yet"}</div></div>
              <span className="rounded-full bg-accent-soft px-2 py-1 text-[9px] font-bold uppercase text-accent">active</span>
            </div>
          ))}
          {!passkeys.some((key) => !key.revokedAt) && <Empty text="No active Passkey" />}
        </div>
        <div className="flex gap-2 border-t border-line bg-bg/50 p-4">
          <input className={`${inputCls} min-w-0 flex-1`} value={passkeyLabel} onChange={(event) => setPasskeyLabel(event.target.value)} placeholder="例如 MacBook Touch ID" />
          <button className={btnPrimary} disabled={busy} onClick={() => void addPasskey()}>{busy ? "Waiting…" : "Add Passkey"}</button>
        </div>
      </section>

      <div className="space-y-5">
        <section className="surface-shadow rounded-2xl border border-line bg-panel p-5">
          <SectionTitle eyebrow="Account identity" title={actor?.kind === "account" ? actor.account.displayName : "Account"} description="Recovery 时需要 Account ID；它不是 secret。" />
          <code className="mt-4 block break-all rounded-xl border border-line bg-bg px-3 py-2 text-[11px]">{actor?.kind === "account" ? actor.account.id : "—"}</code>
          <div className="mt-3 rounded-xl border border-line bg-bg px-3 py-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-dim">GitHub identity</div>
            <div className="mt-2 text-xs font-semibold">{identities.find((identity) => identity.provider === "github") ? `Linked · user ${identities.find((identity) => identity.provider === "github")!.subject}` : "Not linked"}</div>
            <button className={`${btnGhost} mt-3 w-full`} disabled={busy} onClick={() => void linkGitHub()}>{identities.some((identity) => identity.provider === "github") ? "Verify GitHub again" : "Link GitHub"}</button>
          </div>
        </section>
        <section className="surface-shadow rounded-2xl border border-line bg-panel p-5">
          <SectionTitle eyebrow="Personal access" title="PATs" description="由当前 Account 自己签发；raw token 只展示一次。" />
          {rawToken && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3"><div className="text-[10px] font-bold uppercase text-amber-700">Copy now</div><code className="mt-2 block break-all text-xs">{rawToken}</code><button className={`${btnGhost} mt-3`} onClick={() => { void navigator.clipboard.writeText(rawToken); toast("PAT 已复制", "success"); }}>Copy PAT</button></div>}
          <div className="mt-4"><Field label="Label"><input className={inputCls} value={tokenLabel} onChange={(event) => setTokenLabel(event.target.value)} /></Field><Field label="Workspace binding"><select className={inputCls} value={tokenWorkspace} onChange={(event) => setTokenWorkspace(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></Field><button className={`${btnPrimary} w-full`} disabled={busy || !tokenWorkspace} onClick={() => void issuePat()}>Create scoped PAT</button></div>
          <div className="mt-4 space-y-2">{tokens.filter((token) => !token.revokedAt).map((token) => <div key={token.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2"><div className="min-w-0"><div className="truncate text-xs font-semibold">{token.label}</div><div className="mt-1 text-[9px] text-dim">{token.prefix} · {token.scopes.join(", ")}</div></div><button className="text-[10px] font-semibold text-canceled" onClick={async () => { await revokePersonalAccessToken(token.id); await reload(); }}>Revoke</button></div>)}</div>
        </section>
      </div>
    </div>
  );
}

function MembersPanel() {
  const toast = useToast();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [invitationLink, setInvitationLink] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const [nextMembers, nextInvitations] = await Promise.all([
      listMembers(),
      listInvitations(),
    ]);
    setMembers(nextMembers);
    setInvitations(nextInvitations);
  };

  useEffect(() => {
    void reload().catch((error) =>
      toast(error instanceof Error ? error.message : String(error), "error"),
    );
  }, []);

  const invite = async () => {
    setBusy(true);
    try {
      const created = await createInvitation({
        email: email.trim() || undefined,
        role,
      });
      setInvitationLink(`${location.origin}/login?invite=${encodeURIComponent(created.token)}`);
      setEmail("");
      await reload();
      toast("Invitation 已创建；link 只展示一次", "success");
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

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[1fr_380px]">
      <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="border-b border-line p-5">
          <SectionTitle
            eyebrow="Workspace RBAC"
            title="Memberships"
            description="Membership 只连接 Account 与当前 Workspace；历史资源不属于个人。"
          />
        </div>
        <div className="divide-y divide-line">
          {members.map((member) => (
            <div
              key={member.id}
              className="grid items-center gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_130px_130px]"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{member.name}</div>
                <div className="mt-1 truncate text-[10px] text-dim">
                  {member.email || member.accountId}
                </div>
              </div>
              <select
                className={`${inputCls} py-2 text-xs`}
                value={member.role}
                onChange={(event) =>
                  void patchMember(member, { role: event.target.value as WorkspaceRole })
                }
              >
                {["owner", "admin", "member"].map((item) => <option key={item}>{item}</option>)}
              </select>
              <select
                className={`${inputCls} py-2 text-xs`}
                value={member.status}
                onChange={(event) =>
                  void patchMember(member, { status: event.target.value as WorkspaceMember["status"] })
                }
              >
                {["active", "disabled"].map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>
          ))}
          {!members.length && <Empty text="No Memberships in this Workspace" />}
        </div>
      </section>

      <div className="space-y-5">
        <section className="surface-shadow rounded-2xl border border-line bg-panel p-5">
          <SectionTitle
            eyebrow="Invite-only"
            title="Create invitation"
            description="邀请不会提前创建 Account；接收者登录后原子创建 Membership。"
          />
          <div className="mt-5">
            <Field label="Email（optional binding）">
              <input
                type="email"
                className={inputCls}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@example.com"
              />
            </Field>
            <Field label="Initial role">
              <select className={inputCls} value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)}>
                {["member", "admin", "owner"].map((item) => <option key={item}>{item}</option>)}
              </select>
            </Field>
            <button className={`${btnPrimary} w-full`} disabled={busy} onClick={() => void invite()}>
              {busy ? "Creating…" : "Create invitation link"}
            </button>
          </div>
          {invitationLink && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="text-[10px] font-bold uppercase text-amber-700">Copy now</div>
              <code className="mt-2 block break-all text-[10px]">{invitationLink}</code>
              <button className={`${btnGhost} mt-3`} onClick={() => { void navigator.clipboard.writeText(invitationLink); toast("Invitation link 已复制", "success"); }}>Copy link</button>
            </div>
          )}
        </section>

        <section className="surface-shadow rounded-2xl border border-line bg-panel p-5">
          <SectionTitle eyebrow="Pending" title="Invitations" description="过期、接受或撤销后 token 都不能再次使用。" />
          <div className="mt-4 space-y-2">
            {invitations.filter((invitation) => invitation.status === "pending").map((invitation) => (
              <div key={invitation.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
                <div className="min-w-0"><div className="truncate text-xs font-semibold">{invitation.email || "Any authenticated Account"}</div><div className="mt-1 text-[9px] text-dim">{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</div></div>
                <button className="text-[10px] font-semibold text-canceled" onClick={async () => { await revokeInvitation(invitation.id); await reload(); }}>Revoke</button>
              </div>
            ))}
            {!invitations.some((invitation) => invitation.status === "pending") && <Empty text="No pending invitations" />}
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
  const [github, setGitHub] = useState<GitHubIntegrationView | null>(null);
  const reload = async () => {
    try {
      const [repos, roster, lark, scmEvents, issueLabels, githubState] = await Promise.all([
        listRepositories(),
        listAgents(),
        listLarkBindings(),
        listScmEvents(),
        listLabels(),
        getGitHubIntegration(),
      ]);
      setRepositories(repos);
      setAgents(roster);
      setBindings(lark.bindings);
      setCustomBotConfigured(lark.customBotConfigured);
      setEvents(scmEvents);
      setLabels(issueLabels);
      setGitHub(githubState);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  useEffect(() => {
    void reload();
    const params = new URLSearchParams(location.search);
    const githubError = params.get("github_error");
    if (githubError) toast(githubError, "error");
    else if (params.get("github") === "connected") toast("GitHub App installation 已连接", "success");
  }, []);
  return (
    <div className="space-y-5">
      <GitHubSection github={github} onChanged={reload} />
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

function GitHubSection({
  github,
  onChanged,
}: {
  github: GitHubIntegrationView | null;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const install = async () => {
    setBusy("install");
    try {
      const started = await beginGitHubInstallation();
      location.assign(started.url);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
      setBusy("");
    }
  };
  const sync = async (installationId: string) => {
    setBusy(`sync:${installationId}`);
    try {
      const result = await syncGitHubInstallation(installationId);
      await onChanged();
      toast(`GitHub 已同步：${result.connected} mappings · ${result.aliases} aliases · ${result.created} created · ${result.removed} removed`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy("");
    }
  };
  const disconnect = async (installationId: string) => {
    setBusy(`disconnect:${installationId}`);
    try {
      await disconnectGitHubInstallation(installationId);
      await onChanged();
      toast("GitHub App connection 已断开；GitHub 侧 installation 未卸载", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line p-5">
        <SectionTitle
          eyebrow="GitHub App"
          title={github?.configured ? github.appSlug : "Not configured"}
          description="Account identity 负责登录；Workspace installation 负责 Repository、PR、checks 与 merge。短期 installation token 只存在 server 内存。"
        />
        {github?.configured && <button className={btnPrimary} disabled={!!busy} onClick={() => void install()}>{busy === "install" ? "Redirecting…" : "Install / connect"}</button>}
      </div>
      {!github ? <div className="p-5 text-xs text-dim">Loading GitHub integration…</div> : !github.configured ? <div className="p-5"><Empty text="Server 尚未配置 GitHub App" /></div> : (
        <div className="divide-y divide-line">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs">
            <span>Account identity</span>
            <span className={github.identity ? "font-semibold text-accent" : "text-dim"}>{github.identity ? `linked · ${github.identity.subject}` : "not linked (installation flow will link it)"}</span>
          </div>
          {github.installations.map(({ installation, connection, repositories }) => (
            <div key={installation.installationId} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold">{installation.targetLogin}</div>
                  <div className="mt-1 text-[10px] text-dim">{installation.targetType} · installation {installation.installationId} · {installation.repositorySelection} · {installation.status}/{connection.status}</div>
                </div>
                <div className="flex gap-2">
                  <button className={btnGhost} disabled={!!busy || connection.status !== "active"} onClick={() => void sync(installation.installationId)}>{busy === `sync:${installation.installationId}` ? "Syncing…" : "Sync repositories"}</button>
                  <button className={btnDanger} disabled={!!busy || connection.status !== "active"} onClick={() => void disconnect(installation.installationId)}>{busy === `disconnect:${installation.installationId}` ? "Disconnecting…" : "Disconnect"}</button>
                </div>
              </div>
              <div className="mt-4 grid gap-2 md:grid-cols-2">
                {repositories.map((repository) => <div key={`${repository.workspaceId}:${repository.githubRepositoryId}`} className="rounded-xl border border-line bg-bg px-3 py-2"><div className="text-xs font-semibold">{repository.fullName}</div><div className="mt-1 text-[9px] text-dim">{repository.private ? "private" : "public"} · {repository.defaultBranch} · {repository.status}</div></div>)}
                {!repositories.length && <Empty text="No repositories connected" />}
              </div>
            </div>
          ))}
          {!github.installations.length && <div className="p-5"><Empty text="No GitHub App installation connected to this Workspace" /></div>}
          <div className="bg-bg/50 px-5 py-3 text-[10px] leading-5 text-dim">GitHub 侧授权范围请在 <a className="font-semibold text-accent" href="https://github.com/settings/installations" target="_blank" rel="noreferrer">Installed GitHub Apps</a> 调整；变更会通过全局 App webhook 自动同步。</div>
        </div>
      )}
    </section>
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
