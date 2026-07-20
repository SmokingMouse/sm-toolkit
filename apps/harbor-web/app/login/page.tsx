"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import {
  acceptInvitation,
  beginBootstrap,
  beginGitHubLogin,
  beginInvitationRegistration,
  beginLogin,
  bootstrapStatus,
  finishBootstrap,
  finishInvitationRegistration,
  finishLogin,
  githubAuthStatus,
  recoverSession,
} from "../../lib/api";
import { btnGhost, btnPrimary, Field, inputCls } from "../../components/ui";

type Mode = "loading" | "bootstrap" | "invitation" | "login" | "recovery";
type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

function HarborMark() {
  return (
    <svg viewBox="0 0 56 56" className="h-14 w-14" aria-hidden="true">
      <rect width="56" height="56" rx="16" fill="#dcefe9" />
      <path d="M16 14v16a12 12 0 0 0 24 0V14M12 22h32M21 38l-6 6M35 38l6 6" fill="none" stroke="#087f6f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("loading");
  const [displayName, setDisplayName] = useState("Local owner");
  const [invitationToken, setInvitationToken] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [githubConfigured, setGitHubConfigured] = useState(false);

  useEffect(() => {
    const invitation = new URLSearchParams(location.search).get("invite") ?? "";
    setInvitationToken(invitation);
    const githubError = new URLSearchParams(location.search).get("github_error");
    if (githubError) setError(githubError);
    Promise.all([bootstrapStatus(), githubAuthStatus()])
      .then(([state, github]) => {
        setGitHubConfigured(github.configured);
        setMode(state.required ? "bootstrap" : invitation ? "invitation" : "login");
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setMode("login");
      });
  }, []);

  const enterHarbor = async () => {
    const invitation = new URLSearchParams(location.search).get("invite");
    if (invitation) await acceptInvitation(invitation);
    location.href = "/";
  };

  const bootstrap = async () => {
    if (!displayName.trim() || !bootstrapToken.trim()) return;
    setBusy(true);
    setError("");
    try {
      const options = await beginBootstrap(displayName.trim(), bootstrapToken.trim()) as RegistrationOptions;
      const response = await startRegistration({ optionsJSON: options });
      const completed = await finishBootstrap(response, bootstrapToken.trim(), "First owner Passkey");
      setBootstrapToken("");
      setRecoveryCodes(completed.recoveryCodes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    setBusy(true);
    setError("");
    try {
      const options = await beginLogin() as AuthenticationOptions;
      const response = await startAuthentication({ optionsJSON: options });
      await finishLogin(response);
      await enterHarbor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const registerFromInvitation = async () => {
    if (!displayName.trim() || !invitationToken) return;
    setBusy(true);
    setError("");
    try {
      const options = await beginInvitationRegistration(invitationToken, displayName.trim()) as RegistrationOptions;
      const response = await startRegistration({ optionsJSON: options });
      const completed = await finishInvitationRegistration(response, "Invitation Passkey");
      history.replaceState(null, "", "/login");
      setInvitationToken("");
      setRecoveryCodes(completed.recoveryCodes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const recover = async () => {
    if (!accountId.trim() || !recoveryCode.trim()) return;
    setBusy(true);
    setError("");
    try {
      await recoverSession(accountId.trim(), recoveryCode.trim());
      await enterHarbor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const loginWithGitHub = async () => {
    setBusy(true);
    setError("");
    try {
      const started = await beginGitHubLogin(invitationToken || undefined);
      location.assign(started.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <main className="harbor-grid relative grid min-h-screen overflow-hidden bg-bg lg:grid-cols-[minmax(320px,0.9fr)_minmax(520px,1.1fr)]">
      <section className="relative hidden overflow-hidden bg-harbor p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -right-24 top-12 h-72 w-72 rounded-full border border-white/5" />
        <div className="absolute -right-10 top-26 h-72 w-72 rounded-full border border-white/5" />
        <div className="absolute bottom-[-130px] left-[-70px] h-80 w-80 rounded-full bg-accent/15 blur-3xl" />
        <div className="relative flex items-center gap-4">
          <HarborMark />
          <div>
            <div className="text-lg font-semibold tracking-[0.18em]">HARBOR</div>
            <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.24em] text-white/35">Identity checkpoint</div>
          </div>
        </div>
        <div className="relative max-w-xl">
          <div className="mb-5 flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.22em] text-[#83d6c5]">
            <span className="h-px w-9 bg-[#83d6c5]/60" />
            Local control plane
          </div>
          <h1 className="max-w-lg text-5xl font-semibold leading-[1.08] tracking-[-0.04em]">Your agents wait behind one human identity.</h1>
          <p className="mt-6 max-w-md text-sm leading-7 text-white/50">GitHub 证明外部身份，Passkey 保留为本机登录；Workspace 授权仍由 Harbor 独立控制，不把长期 GitHub token 留在浏览器或数据库。</p>
        </div>
        <div className="relative grid grid-cols-3 gap-3 border-t border-white/8 pt-6 text-[10px] uppercase tracking-[0.13em] text-white/35">
          <span>Passkey</span><span>Session</span><span>Workspace RBAC</span>
        </div>
      </section>

      <section className="relative flex items-center justify-center px-5 py-10 sm:px-10">
        <div className="page-enter w-full max-w-[480px]">
          <div className="mb-8 flex items-center gap-3 lg:hidden"><HarborMark /><div className="text-sm font-semibold tracking-[0.16em]">HARBOR</div></div>
          <div className="surface-shadow rounded-[28px] border border-white/80 bg-panel p-7 sm:p-9">
            {recoveryCodes.length > 0 ? (
              <>
                <div className="text-[10px] font-bold uppercase tracking-[0.19em] text-accent">One-time recovery kit</div>
                <h2 className="mt-3 text-2xl font-semibold tracking-[-0.025em]">先保存，再进 Harbor</h2>
                <p className="mt-3 text-xs leading-5 text-dim">这些 recovery codes 只展示一次。每个 code 只能用一次，服务端只保存 hash。</p>
                <div className="mt-6 grid grid-cols-2 gap-2 rounded-2xl border border-line bg-bg p-4 font-mono text-[11px]">
                  {recoveryCodes.map((code) => <code key={code}>{code}</code>)}
                </div>
                <button className={`${btnGhost} mt-4 w-full`} onClick={() => void navigator.clipboard.writeText(recoveryCodes.join("\n"))}>复制 recovery codes</button>
                <button className={`${btnPrimary} mt-3 w-full`} onClick={() => void enterHarbor()}>我已安全保存</button>
              </>
            ) : (
              <>
                <div className="text-[10px] font-bold uppercase tracking-[0.19em] text-accent">
                  {mode === "bootstrap" ? "First owner bootstrap" : mode === "invitation" ? "Workspace invitation" : mode === "recovery" ? "Recovery access" : "Secure sign in"}
                </div>
                <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">
                  {mode === "bootstrap" ? "绑定第一枚 Passkey" : mode === "invitation" ? "创建 Account 并加入" : mode === "recovery" ? "使用一次性恢复码" : "回到你的 Workspace"}
                </h2>
                <p className="mt-3 text-sm leading-6 text-dim">
                  {mode === "bootstrap" ? "首次设置同时需要 system bootstrap token。它只停留在这个表单的内存中。" : mode === "invitation" ? "可由 GitHub identity 或 Passkey 接收 Invitation；Membership 只在验证成功后创建。" : mode === "recovery" ? "Account ID 可在 Account settings 中查看；成功后该 code 立即失效。" : "使用已绑定的 GitHub identity，或设备上的 discoverable Passkey。"}
                </p>

                {mode === "bootstrap" && <div className="mt-7"><Field label="Display name"><input autoComplete="name" className={inputCls} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field><Field label="System bootstrap token"><input autoComplete="off" type="password" className={inputCls} value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} /></Field></div>}
                {mode === "invitation" && <div className="mt-7"><Field label="Display name"><input autoComplete="name" className={inputCls} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field><div className="rounded-xl border border-line bg-bg px-3 py-2 text-[10px] leading-5 text-dim">Invitation token loaded from this one-time link.</div></div>}
                {mode === "recovery" && <div className="mt-7"><Field label="Account ID"><input autoComplete="username" className={`${inputCls} font-mono`} value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="acc_…" /></Field><Field label="Recovery code"><input autoComplete="one-time-code" className={`${inputCls} font-mono uppercase`} value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" /></Field></div>}

                {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-canceled">{error}</div>}
                {mode === "loading" ? <div className="mt-8 text-sm text-dim">正在读取 Harbor 登录方式…</div> : mode === "bootstrap" ? <button className={`${btnPrimary} mt-7 w-full`} disabled={busy || !displayName.trim() || !bootstrapToken.trim()} onClick={() => void bootstrap()}>{busy ? "等待 Passkey…" : "Create first-owner Passkey"}</button> : mode === "invitation" ? <button className={`${btnPrimary} mt-7 w-full`} disabled={busy || !displayName.trim()} onClick={() => void registerFromInvitation()}>{busy ? "等待 Passkey…" : "Register with Passkey"}</button> : mode === "recovery" ? <button className={`${btnPrimary} mt-7 w-full`} disabled={busy || !accountId.trim() || !recoveryCode.trim()} onClick={() => void recover()}>{busy ? "验证中…" : "Use recovery code"}</button> : <button className={`${btnPrimary} mt-7 w-full`} disabled={busy} onClick={() => void login()}>{busy ? "等待 Passkey…" : "Continue with Passkey"}</button>}

                {githubConfigured && (mode === "login" || mode === "invitation") && <><div className="my-4 flex items-center gap-3 text-[10px] uppercase tracking-[0.16em] text-dim"><span className="h-px flex-1 bg-line" /><span>or</span><span className="h-px flex-1 bg-line" /></div><button className={`${btnGhost} w-full`} disabled={busy} onClick={() => void loginWithGitHub()}>{busy ? "Redirecting…" : mode === "invitation" ? "Accept with GitHub" : "Continue with GitHub"}</button></>}

                {mode !== "loading" && mode !== "bootstrap" && <button type="button" className="mt-4 w-full text-xs font-semibold text-dim hover:text-ink" onClick={() => { setError(""); setMode(mode === "recovery" ? "login" : "recovery"); }}>{mode === "recovery" ? "返回 Passkey 登录" : "Passkey 不可用？使用 recovery code"}</button>}
                {mode === "invitation" && <button type="button" className="mt-3 w-full text-xs font-semibold text-dim hover:text-ink" onClick={() => { setError(""); setMode("login"); }}>已有 Account？先登录并接受邀请</button>}
              </>
            )}
          </div>
          <p className="mt-5 text-center text-[10px] uppercase tracking-[0.13em] text-dim">RP and origin are pinned by HARBOR_PUBLIC_URL</p>
        </div>
      </section>
    </main>
  );
}
