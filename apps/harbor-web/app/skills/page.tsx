"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSkill,
  createSkillGroup,
  deleteSkillGroup,
  importRuntimeSkills,
  importSkillSource,
  listDevices,
  listSkillGroups,
  listSkills,
  syncRemoteSkill,
  updateSkill,
  type Device,
  type SkillDependency,
  type SkillGroup,
  type SkillSource,
  type SkillWithAgents,
} from "../../lib/api";
import { usePoll } from "../../lib/hooks";
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

type PanelMode = "detail" | "create" | "sync" | "import" | "groups";

export default function SkillsPage() {
  const skills = usePoll(listSkills, 10_000);
  const devices = usePoll(listDevices, 10_000);
  const groups = usePoll(listSkillGroups, 10_000);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>("detail");
  const allSkills = skills.data ?? [];
  const allGroups = groups.data ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? allSkills.filter((skill) =>
          `${skill.name} ${skill.description} ${skill.source}`
            .toLowerCase()
            .includes(needle),
        )
      : allSkills;
  }, [allSkills, query]);
  const selected =
    allSkills.find((skill) => skill.id === selectedId) ?? allSkills[0];
  const groupSections = useMemo(
    () =>
      [
        ...allGroups.map((group) => ({
          id: group.id,
          name: group.name,
          skills: filtered.filter((skill) => skill.groupId === group.id),
        })),
        {
          id: "ungrouped",
          name: "Ungrouped",
          skills: filtered.filter((skill) => !skill.groupId),
        },
      ].filter((section) => section.skills.length > 0),
    [allGroups, filtered],
  );

  useEffect(() => {
    if (!selectedId && allSkills[0]) setSelectedId(allSkills[0].id);
    if (selectedId && !allSkills.some((skill) => skill.id === selectedId))
      setSelectedId(allSkills[0]?.id ?? null);
  }, [allSkills, selectedId]);
  const finish = (id?: string) => {
    if (id) setSelectedId(id);
    setMode("detail");
    skills.reload();
    devices.reload();
    groups.reload();
  };

  return (
    <div className="page-enter flex h-full flex-col p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Reusable capability"
        title="Skills"
        description="多文件 Skill bundle、来源同步与依赖快照；绑定后在每次 Run 的 system prompt 中真实生效。"
        actions={
          <>
            <button className={btnGhost} onClick={() => setMode("groups")}>
              Groups
            </button>
            <button className={btnGhost} onClick={() => setMode("sync")}>
              ↻ Local
            </button>
            <button className={btnGhost} onClick={() => setMode("import")}>
              ⇣ Import
            </button>
            <button className={btnPrimary} onClick={() => setMode("create")}>
              ＋ New Skill
            </button>
          </>
        }
      />
      {skills.error && (
        <div className="mb-3 text-sm text-canceled">{skills.error}</div>
      )}
      <div className="surface-shadow grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-line bg-panel/88 max-lg:grid-cols-[300px_minmax(0,1fr)] max-md:grid-cols-1 max-md:overflow-auto">
        <aside className="flex min-h-0 flex-col border-r border-line bg-white/45 max-md:max-h-[360px] max-md:border-b max-md:border-r-0">
          <div className="border-b border-line p-3">
            <input
              className={`${inputCls} min-h-10 py-2 text-xs`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, source, description"
            />
            <div className="mt-2 flex justify-between px-1 text-[10px] text-dim">
              <span>{allSkills.length} skills</span>
              <span>
                {allSkills.filter((skill) => skill.autoSync).length} auto-sync
              </span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2.5">
            {groupSections.map((section) => (
              <div key={section.id} className="mb-4">
                <div className="mb-1.5 px-2 text-[9px] font-bold uppercase tracking-[0.13em] text-dim">
                  {section.name}
                </div>
                {section.skills.map((skill) => (
                  <button
                    key={skill.id}
                    className={`mb-1 flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left ${mode === "detail" && selected?.id === skill.id ? "border-accent/35 bg-accent-soft/60 shadow-[inset_3px_0_0_var(--color-accent)]" : "border-transparent hover:border-line hover:bg-white"}`}
                    onClick={() => {
                      setSelectedId(skill.id);
                      setMode("detail");
                    }}
                  >
                    <SkillMark source={skill.source} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold">
                        {skill.name}
                      </span>
                      <span className="mt-1 block truncate text-[10px] text-dim">
                        {skill.description || "Workspace Skill"}
                      </span>
                      <span className="mt-1.5 block text-[9px] font-medium uppercase tracking-[0.08em] text-dim/75">
                        {skill.source} · {skill.files.length} files ·{" "}
                        {skill.agents.length} agents
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {!groupSections.length && (
              <Empty text={query ? "没有匹配的 Skill" : "还没有 Skill"} />
            )}
          </div>
        </aside>
        <section className="min-h-0 overflow-y-auto bg-panel">
          {mode === "create" ? (
            <CreateSkillPanel
              groups={allGroups}
              onClose={() => setMode("detail")}
              onCreated={finish}
            />
          ) : mode === "sync" ? (
            <SyncSkillsPanel
              devices={devices.data ?? []}
              skills={allSkills}
              onClose={() => setMode("detail")}
              onSynced={finish}
            />
          ) : mode === "import" ? (
            <ImportSkillPanel
              groups={allGroups}
              onClose={() => setMode("detail")}
              onImported={finish}
            />
          ) : mode === "groups" ? (
            <GroupsPanel
              groups={allGroups}
              onClose={() => setMode("detail")}
              onChanged={() => {
                groups.reload();
                skills.reload();
              }}
            />
          ) : selected ? (
            <SkillDetail
              key={selected.id}
              skill={selected}
              devices={devices.data ?? []}
              groups={allGroups}
              onChanged={() => finish(selected.id)}
            />
          ) : (
            <div className="grid min-h-full place-items-center p-8">
              <Empty text="选择或导入一个 Skill" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SkillMark({
  source,
  large,
}: {
  source: SkillSource;
  large?: boolean;
}) {
  const style =
    source === "runtime"
      ? "border-blue-200 bg-blue-50 text-blue-700"
      : source === "codebase"
        ? "border-orange-200 bg-orange-50 text-orange-700"
        : source === "github"
          ? "border-zinc-300 bg-zinc-100 text-zinc-700"
          : source === "upload"
            ? "border-violet-200 bg-violet-50 text-violet-700"
            : "border-accent/20 bg-accent-soft text-accent-strong";
  return (
    <span
      className={`${large ? "h-12 w-12 rounded-2xl" : "h-9 w-9 shrink-0 rounded-xl"} grid place-items-center border ${style}`}
    >
      <span className="text-[10px] font-bold uppercase">
        {source.slice(0, 2)}
      </span>
    </span>
  );
}

function SkillDetail({
  skill,
  devices,
  groups,
  onChanged,
}: {
  skill: SkillWithAgents;
  devices: Device[];
  groups: SkillGroup[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [instruction, setInstruction] = useState(skill.instruction);
  const [groupId, setGroupId] = useState(skill.groupId ?? "");
  const [autoSync, setAutoSync] = useState(skill.autoSync);
  const [busy, setBusy] = useState(false);
  const device = devices.find((item) => item.id === skill.deviceId);
  const editableBody =
    skill.source !== "runtime" &&
    skill.source !== "codebase" &&
    skill.source !== "github";
  const remote = skill.source === "codebase" || skill.source === "github";
  const save = async () => {
    setBusy(true);
    try {
      await updateSkill(skill.id, {
        name: name.trim(),
        description: description.trim(),
        groupId: groupId || null,
        ...(editableBody
          ? {
              instruction: instruction.trim(),
              files: skill.files.map((file) => ({
                path: file.path,
                content:
                  file.path === "SKILL.md" ? instruction.trim() : file.content,
              })),
            }
          : {}),
        ...(remote || skill.source === "runtime" ? { autoSync } : {}),
      });
      toast(`已更新 ${name}`, "success");
      setEditing(false);
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (
      !confirm(
        `归档 Skill "${skill.name}"？它会立即从 ${skill.agents.length} 个 Agent 解绑。`,
      )
    )
      return;
    await updateSkill(skill.id, { archived: true });
    toast(`已归档 ${skill.name}`, "success");
    onChanged();
  };
  const sync = async () => {
    setBusy(true);
    try {
      await syncRemoteSkill(skill.id);
      toast("远端 bundle 已刷新", "success");
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="min-h-full">
      <div className="h-1 bg-accent" />
      <div className="p-6 max-sm:p-4">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-5">
          <div className="flex min-w-0 items-center gap-3">
            <SkillMark source={skill.source} large />
            <div>
              <h2 className="text-xl font-semibold">{skill.name}</h2>
              <div className="mt-1 text-[11px] uppercase text-dim">
                {skill.source} · {skill.runtimes.join(" + ")} ·{" "}
                {skill.agents.length} agents
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            {remote && (
              <button className={btnGhost} disabled={busy} onClick={sync}>
                Sync now
              </button>
            )}
            <button className={btnGhost} onClick={() => setEditing(!editing)}>
              {editing ? "取消" : "编辑"}
            </button>
            <button className={btnDanger} onClick={archive}>
              归档
            </button>
          </div>
        </div>
        {editing ? (
          <div className="max-w-3xl">
            <div className="grid gap-x-5 md:grid-cols-2">
              <Field label="Name">
                <input
                  className={inputCls}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="Group">
                <select
                  className={inputCls}
                  value={groupId}
                  onChange={(event) => setGroupId(event.target.value)}
                >
                  <option value="">Ungrouped</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Description">
              <input
                className={inputCls}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field
              label={
                editableBody
                  ? "SKILL.md"
                  : "SKILL.md snapshot · managed by source sync"
              }
            >
              <textarea
                className={`${inputCls} min-h-72 resize-y font-mono text-xs leading-6`}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                disabled={!editableBody}
              />
            </Field>
            {(remote || skill.source === "runtime") && (
              <label className="mb-5 flex gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={(event) => setAutoSync(event.target.checked)}
                />{" "}
                Auto-sync source changes
              </label>
            )}
            <button
              className={btnPrimary}
              disabled={busy || !name.trim() || !instruction.trim()}
              onClick={save}
            >
              {busy ? "保存中…" : "保存更改"}
            </button>
          </div>
        ) : (
          <>
            <p className="mb-5 max-w-3xl text-sm leading-6 text-dim">
              {skill.description || "No description."}
            </p>
            <div className="mb-5 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
              <SkillFact
                label="Source"
                value={
                  skill.source === "runtime"
                    ? (device?.name ?? skill.deviceId ?? "runtime")
                    : (skill.originUrl ?? skill.source)
                }
              />
              <SkillFact
                label="Group"
                value={
                  groups.find((group) => group.id === skill.groupId)?.name ??
                  "Ungrouped"
                }
              />
              <SkillFact
                label="Entry hash"
                value={skill.entryHash.slice(0, 12) || "—"}
                mono
              />
              <SkillFact
                label="Bundle hash"
                value={skill.bundleHash.slice(0, 12) || "—"}
                mono
              />
            </div>
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_310px]">
              <div className="rounded-xl border border-line bg-white/55 p-4">
                <div className="mb-3 text-xs font-medium text-dim">
                  SKILL.md snapshot
                </div>
                <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-ink/80">
                  {skill.instruction}
                </pre>
              </div>
              <aside className="space-y-4">
                <BundleList
                  title={`Bundle · ${skill.files.length} files`}
                  rows={skill.files.map(
                    (file) => `${file.path} · ${file.sha256.slice(0, 8)}`,
                  )}
                />
                <BundleList
                  title={`Dependencies · ${skill.dependencies.length}`}
                  rows={skill.dependencies.map(
                    (dependency) =>
                      `${dependency.name}${dependency.spec ? ` ${dependency.spec}` : ""}${dependency.required ? "" : " (optional)"}`,
                  )}
                />
                <BundleList
                  title={`Used by · ${skill.agents.length}`}
                  rows={skill.agents.map((agent) => agent.name)}
                />
              </aside>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function CreateSkillPanel({
  groups,
  onClose,
  onCreated,
}: {
  groups: SkillGroup[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] = useState("");
  const [groupId, setGroupId] = useState("");
  const [extraFiles, setExtraFiles] = useState<
    { path: string; content: string }[]
  >([]);
  const [dependencies, setDependencies] = useState("");
  const [busy, setBusy] = useState(false);
  const upload = async (files?: FileList | null) => {
    if (!files) return;
    const rows = await Promise.all(
      [...files].map(async (file) => ({
        path: file.webkitRelativePath || file.name,
        content: await file.text(),
      })),
    );
    const entry = rows.find((file) => file.path.endsWith("SKILL.md"));
    if (entry) {
      setInstruction(entry.content);
      const meta = parseFrontmatter(entry.content);
      if (meta.name) setName(meta.name);
      if (meta.description) setDescription(meta.description);
    }
    setExtraFiles(rows.filter((file) => !file.path.endsWith("SKILL.md")));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const skill = await createSkill({
        name: name.trim(),
        description: description.trim(),
        instruction: instruction.trim(),
        groupId: groupId || null,
        files: [
          { path: "SKILL.md", content: instruction.trim() },
          ...extraFiles,
        ],
        dependencies: parseDependencies(dependencies),
      });
      toast(`Skill "${skill.name}" 已创建`, "success");
      onCreated(skill.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex min-h-full flex-col" onSubmit={submit}>
      <PanelHeader
        eyebrow="New Skill"
        title="Create a bundle"
        onClose={onClose}
      />
      <div className="mx-auto w-full max-w-[860px] flex-1 px-7 py-6 max-sm:px-4">
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-dashed border-accent/30 bg-accent-soft/35 p-4">
          <div>
            <div className="text-sm font-semibold">Upload files</div>
            <div className="mt-1 text-xs text-dim">
              SKILL.md 是入口；scripts、references、assets 以相对路径保存。
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => void upload(event.target.files)}
          />
          <button
            type="button"
            className={btnGhost}
            onClick={() => fileRef.current?.click()}
          >
            Choose files
          </button>
        </div>
        <div className="grid gap-x-5 md:grid-cols-2">
          <Field label="Name">
            <input
              className={inputCls}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Group">
            <select
              className={inputCls}
              value={groupId}
              onChange={(event) => setGroupId(event.target.value)}
            >
              <option value="">Ungrouped</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description">
          <input
            className={inputCls}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label="SKILL.md">
          <textarea
            className={`${inputCls} min-h-[330px] resize-y font-mono text-xs leading-6`}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </Field>
        <Field label="Dependencies（one per line: name[@spec][?]）">
          <textarea
            className={`${inputCls} min-h-24 font-mono text-xs`}
            value={dependencies}
            onChange={(event) => setDependencies(event.target.value)}
            placeholder={"rg\nbitscli@>=1.0\noptional-tool?"}
          />
        </Field>
        {extraFiles.length > 0 && (
          <BundleList
            title={`${extraFiles.length} extra files`}
            rows={extraFiles.map((file) => file.path)}
          />
        )}
      </div>
      <PanelFooter hint="Manual/upload bundle 可用于所有 Device 和 Runtime">
        <button
          className={btnPrimary}
          disabled={busy || !name.trim() || !instruction.trim()}
        >
          {busy ? "创建中…" : "Create Skill"}
        </button>
      </PanelFooter>
    </form>
  );
}

function ImportSkillPanel({
  groups,
  onClose,
  onImported,
}: {
  groups: SkillGroup[];
  onClose: () => void;
  onImported: (id: string) => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<"codebase" | "github" | "upload">(
    "codebase",
  );
  const [repository, setRepository] = useState("");
  const [path, setPath] = useState(".");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("main");
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [zipBase64, setZipBase64] = useState("");
  const [busy, setBusy] = useState(false);
  const chooseZip = async (file?: File) => {
    if (!file) return;
    setName(name || file.name.replace(/\.zip$/i, ""));
    setZipBase64(arrayBufferToBase64(await file.arrayBuffer()));
  };
  const submit = async () => {
    setBusy(true);
    try {
      const skill = await importSkillSource({
        source,
        name: name.trim() || undefined,
        groupId: groupId || null,
        autoSync,
        ...(source === "codebase"
          ? {
              repository: repository.trim(),
              path: path.trim() || ".",
              ref: ref.trim() || "main",
            }
          : source === "github"
            ? { url: url.trim(), ref: ref.trim() || undefined }
            : { zipBase64 }),
      });
      toast(`已导入 ${skill.name}`, "success");
      onImported(skill.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const ready =
    source === "codebase"
      ? repository.trim()
      : source === "github"
        ? url.trim()
        : zipBase64;
  return (
    <div className="flex min-h-full flex-col">
      <PanelHeader
        eyebrow="Source import"
        title="Import a Skill bundle"
        onClose={onClose}
      />
      <div className="mx-auto w-full max-w-[820px] flex-1 px-7 py-6 max-sm:px-4">
        <div className="mb-5 grid grid-cols-3 gap-2">
          {(["codebase", "github", "upload"] as const).map((item) => (
            <button
              key={item}
              className={`rounded-xl border px-4 py-3 text-xs font-semibold uppercase ${source === item ? "border-harbor bg-harbor text-white" : "border-line bg-bg"}`}
              onClick={() => setSource(item)}
            >
              {item === "upload" ? "ZIP" : item}
            </button>
          ))}
        </div>
        <div className="grid gap-x-5 md:grid-cols-2">
          <Field label="Display name（optional）">
            <input
              className={inputCls}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Group">
            <select
              className={inputCls}
              value={groupId}
              onChange={(event) => setGroupId(event.target.value)}
            >
              <option value="">Ungrouped</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {source === "codebase" ? (
          <>
            <Field label="Codebase repository">
              <input
                className={inputCls}
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="org/project/repository"
              />
            </Field>
            <div className="grid gap-x-5 md:grid-cols-2">
              <Field label="Skill path">
                <input
                  className={inputCls}
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                />
              </Field>
              <Field label="Ref">
                <input
                  className={inputCls}
                  value={ref}
                  onChange={(event) => setRef(event.target.value)}
                />
              </Field>
            </div>
          </>
        ) : source === "github" ? (
          <>
            <Field label="GitHub URL">
              <input
                className={inputCls}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/org/repo/tree/main/skill"
              />
            </Field>
            <Field label="Ref override（optional）">
              <input
                className={inputCls}
                value={ref}
                onChange={(event) => setRef(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-line p-6 text-center">
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => void chooseZip(event.target.files?.[0])}
            />
            <button
              className={btnGhost}
              onClick={() => fileRef.current?.click()}
            >
              {zipBase64 ? "ZIP loaded · replace" : "Choose ZIP bundle"}
            </button>
          </div>
        )}
        {source !== "upload" && (
          <label className="mt-3 flex gap-2 text-xs">
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(event) => setAutoSync(event.target.checked)}
            />{" "}
            Auto-sync remote source every 10 minutes
          </label>
        )}
      </div>
      <PanelFooter hint="Import 会校验路径、bundle 大小、SKILL.md 与依赖元数据">
        <button
          className={btnPrimary}
          disabled={busy || !ready}
          onClick={submit}
        >
          {busy ? "导入中…" : "Import bundle"}
        </button>
      </PanelFooter>
    </div>
  );
}

function SyncSkillsPanel({
  devices,
  skills,
  onClose,
  onSynced,
}: {
  devices: Device[];
  skills: SkillWithAgents[];
  onClose: () => void;
  onSynced: (id?: string) => void;
}) {
  const toast = useToast();
  const availableDevices = devices.filter(
    (device) => (device.capabilities.installedSkills?.length ?? 0) > 0,
  );
  const [deviceId, setDeviceId] = useState(
    (availableDevices.find((device) => device.online) ?? availableDevices[0])
      ?.id ?? "",
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const device = devices.find((item) => item.id === deviceId);
  const candidates = device?.capabilities.installedSkills ?? [];
  const imported = new Map(
    skills
      .filter(
        (skill) => skill.source === "runtime" && skill.deviceId === deviceId,
      )
      .map((skill) => [skill.sourcePath, skill]),
  );
  useEffect(() => setSelected([]), [deviceId]);
  const sync = async () => {
    if (!device || !selected.length) return;
    setBusy(true);
    try {
      const result = await importRuntimeSkills({
        device: device.id,
        paths: selected,
      });
      toast(`已同步 ${result.imported.length} 个 Runtime Skill`, "success");
      onSynced(result.imported[0]?.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full flex-col">
      <PanelHeader
        eyebrow="Runtime sync"
        title="Import local skills"
        onClose={onClose}
      />
      <div className="mx-auto w-full max-w-[820px] flex-1 px-7 py-6 max-sm:px-4">
        <Field label="Device">
          <select
            className={inputCls}
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            {availableDevices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.online ? "Online" : "Offline"} ·{" "}
                {item.capabilities.installedSkills?.length ?? 0}
              </option>
            ))}
          </select>
        </Field>
        {!availableDevices.length ? (
          <Empty text="重启 harbord 后同步本机 Skill bundle" />
        ) : (
          <div className="mt-5 max-h-[530px] overflow-y-auto rounded-xl border border-line p-2">
            {candidates.map((candidate) => {
              const checked = selected.includes(candidate.path);
              return (
                <button
                  key={candidate.path}
                  className={`mb-1 flex w-full gap-3 rounded-xl border p-3 text-left ${checked ? "border-accent/35 bg-accent-soft/55" : "border-transparent hover:border-line"}`}
                  onClick={() =>
                    setSelected((items) =>
                      checked
                        ? items.filter((item) => item !== candidate.path)
                        : [...items, candidate.path],
                    )
                  }
                >
                  <span>{checked ? "☑" : "☐"}</span>
                  <span className="min-w-0">
                    <b className="text-sm">{candidate.name}</b>
                    {imported.has(candidate.path) && (
                      <span className="ml-2 text-[9px] uppercase text-blue-700">
                        synced
                      </span>
                    )}
                    <span className="mt-1 block truncate font-mono text-[9px] text-dim">
                      {candidate.path} · {candidate.files?.length ?? 1} files
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <PanelFooter hint="Runtime auto-sync 会在 daemon hello 时刷新 bundle">
        <button
          className={btnPrimary}
          disabled={busy || !selected.length}
          onClick={sync}
        >
          {busy ? "同步中…" : `Sync ${selected.length || ""}`}
        </button>
      </PanelFooter>
    </div>
  );
}

function GroupsPanel({
  groups,
  onClose,
  onChanged,
}: {
  groups: SkillGroup[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const add = async () => {
    try {
      await createSkillGroup({ name: name.trim() });
      setName("");
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  return (
    <div className="flex min-h-full flex-col">
      <PanelHeader
        eyebrow="Organization"
        title="Skill groups"
        onClose={onClose}
      />
      <div className="mx-auto w-full max-w-[680px] flex-1 px-7 py-6">
        <div className="space-y-2">
          {groups.map((group) => (
            <div
              key={group.id}
              className="flex items-center justify-between rounded-xl border border-line bg-white/55 px-4 py-3"
            >
              <div>
                <div className="text-sm font-semibold">{group.name}</div>
                <div className="mt-1 text-[9px] text-dim">
                  position {group.position}
                </div>
              </div>
              <button
                className={btnDanger}
                onClick={async () => {
                  if (
                    !confirm(
                      `删除 group "${group.name}"？Skill 会移到 Ungrouped。`,
                    )
                  )
                    return;
                  await deleteSkillGroup(group.id);
                  onChanged();
                }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="mt-5 flex gap-2">
          <input
            className={inputCls}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New group name"
          />
          <button className={btnPrimary} disabled={!name.trim()} onClick={add}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillFact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 bg-panel px-4 py-3.5">
      <div className="mb-1.5 text-[10px] text-dim">{label}</div>
      <div
        className={`truncate text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
function BundleList({ title, rows }: { title: string; rows: string[] }) {
  return (
    <div className="rounded-xl border border-line bg-white/55 p-4">
      <div className="mb-3 text-xs font-medium text-dim">{title}</div>
      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div
            key={`${row}-${index}`}
            className="break-all rounded-lg bg-bg px-2.5 py-2 font-mono text-[10px] leading-4"
          >
            {row}
          </div>
        ))}
        {!rows.length && <div className="text-xs text-dim">None</div>}
      </div>
    </div>
  );
}
function PanelHeader({
  eyebrow,
  title,
  onClose,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-7 py-6 max-sm:px-4">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">
          {eyebrow}
        </div>
        <h2 className="mt-1 text-2xl font-semibold">{title}</h2>
      </div>
      <button className={btnGhost} onClick={onClose}>
        取消
      </button>
    </div>
  );
}
function PanelFooter({
  hint,
  children,
}: {
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sticky bottom-0 flex items-center justify-between gap-4 border-t border-line bg-panel/95 px-7 py-4 backdrop-blur max-sm:px-4">
      <span className="text-xs text-dim">{hint}</span>
      {children}
    </div>
  );
}
function parseFrontmatter(text: string): {
  name?: string;
  description?: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const value = (key: string) => {
    const row = match[1]
      ?.split(/\r?\n/)
      .find((line) => line.trim().startsWith(`${key}:`));
    return (
      row
        ?.slice(row.indexOf(":") + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "") || undefined
    );
  };
  return { name: value("name"), description: value("description") };
}
function parseDependencies(value: string): SkillDependency[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const required = !line.endsWith("?");
      const clean = required ? line : line.slice(0, -1);
      const match = /^([^@]+)(?:@(.+))?$/.exec(clean)!;
      return {
        name: match[1]!.trim(),
        spec: match[2]?.trim() || null,
        required,
      };
    });
}
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
