"use client";

import { useRef, useState, type ClipboardEvent } from "react";

export interface ImageAttachmentInput {
  name: string;
  mime: string;
  dataBase64: string;
}

const MAX_IMAGES = 8;
const MAX_BYTES = 20 * 1024 * 1024;

const readImage = (file: File) => new Promise<ImageAttachmentInput>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
  reader.onload = () => {
    const value = String(reader.result ?? "");
    resolve({ name: file.name || "pasted-image", mime: file.type, dataBase64: value.slice(value.indexOf(",") + 1) });
  };
  reader.readAsDataURL(file);
});

export function useImageAttachments(onError: (message: string) => void) {
  const [attachments, setAttachments] = useState<ImageAttachmentInput[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: File[]) => {
    if (files.some((file) => !file.type.startsWith("image/"))) {
      onError("只能上传图片文件");
      return;
    }
    if (attachments.length + files.length > MAX_IMAGES) {
      onError(`单次最多上传 ${MAX_IMAGES} 张图片`);
      return;
    }
    const currentBytes = attachments.reduce((sum, item) => sum + Math.floor(item.dataBase64.length * 3 / 4), 0);
    if (currentBytes + files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) {
      onError("图片总大小不能超过 20MB");
      return;
    }
    try {
      const added = await Promise.all(files.map(readImage));
      setAttachments((current) => [...current, ...added]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    attachments,
    clear: () => setAttachments([]),
    remove: (index: number) => setAttachments((current) => current.filter((_, position) => position !== index)),
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length > 0) void addFiles(files);
    },
    picker: (
      <>
        <input ref={inputRef} className="hidden" type="file" accept="image/*" multiple onChange={(event) => {
          void addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }} />
        <button type="button" className="h-8 rounded-lg border border-line bg-bg px-2.5 text-[10px] font-semibold text-dim hover:text-ink" onClick={() => inputRef.current?.click()}>
          ＋ Image
        </button>
      </>
    ),
  };
}

export function AttachmentPreview({ attachments, onRemove }: { attachments: ImageAttachmentInput[]; onRemove: (index: number) => void }) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto px-1 pb-2">
      {attachments.map((attachment, index) => (
        <div key={`${attachment.name}-${index}`} className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-bg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="h-full w-full object-cover" src={`data:${attachment.mime};base64,${attachment.dataBase64}`} alt={attachment.name} />
          <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => onRemove(index)} className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/65 text-xs text-white opacity-80 hover:opacity-100">×</button>
        </div>
      ))}
    </div>
  );
}

export function AttachmentImages({ owner, id, attachments }: { owner: "messages" | "runs"; id: string; attachments?: { name: string; mime: string }[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((attachment, position) => (
        <a key={`${attachment.name}-${position}`} href={`/api/${owner}/${encodeURIComponent(id)}/attachments/${position}`} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="max-h-56 max-w-full rounded-xl border border-line object-contain" src={`/api/${owner}/${encodeURIComponent(id)}/attachments/${position}`} alt={attachment.name} loading="lazy" />
        </a>
      ))}
    </div>
  );
}
