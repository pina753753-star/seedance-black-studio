"use client";

import {
  AudioLines,
  BadgeCheck,
  Boxes,
  ChevronDown,
  Clapperboard,
  Download,
  Image as ImageIcon,
  Loader2,
  Moon,
  Sparkles,
  Upload,
  Video,
  Wand2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type Mode = "text" | "image" | "reference";
type Resolution = "480p" | "720p" | "1080p";
type AspectRatio = "auto" | "16:9" | "9:16" | "4:3" | "3:4" | "21:9" | "1:1";

type Task = {
  id: string;
  mode: Mode;
  prompt: string;
  resolution: Resolution;
  duration: number;
  aspectRatio: AspectRatio;
  status: "queued" | "processing" | "succeeded" | "failed";
  outputVideoUrl?: string;
  watermarkedUrl?: string;
  error?: string;
  costCredits: number;
  createdAt: string;
};

const resolutionCost: Record<Resolution, number> = {
  "480p": 6,
  "720p": 12,
  "1080p": 30
};

const tabs: Array<{ key: Mode; label: string; icon: React.ReactNode }> = [
  { key: "text", label: "テキストから動画", icon: <Wand2 size={17} /> },
  { key: "image", label: "画像から動画", icon: <ImageIcon size={17} /> },
  { key: "reference", label: "複数リファレンス", icon: <Boxes size={17} /> }
];

const aspectRatios: AspectRatio[] = ["auto", "16:9", "9:16", "4:3", "3:4", "21:9", "1:1"];

function modeTitle(mode: Mode) {
  if (mode === "text") return "文章だけで、映像を立ち上げる";
  if (mode === "image") return "1枚の画像を、自然に動かす";
  return "素材を参照して、狙った動画に寄せる";
}

function modeHint(mode: Mode) {
  if (mode === "text") return "登場人物、場所、動き、カメラ、音を文章で指定してください。";
  if (mode === "image") return "元画像をアップロードして、どんな動きにしたいかを書いてください。";
  return "@Image1 / @Video1 / @Audio1 のように素材をプロンプトで参照できます。";
}

function acceptForMode(mode: Mode) {
  if (mode === "text") return "";
  if (mode === "image") return "image/png,image/jpeg,image/webp";
  return "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp3";
}

export function Studio() {
  const [mode, setMode] = useState<Mode>("reference");
  const [prompt, setPrompt] = useState("");
  const [resolution, setResolution] = useState<Resolution>("480p");
  const [duration, setDuration] = useState(5);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("auto");
  const [realPerson, setRealPerson] = useState(false);
  const [returnLastFrame, setReturnLastFrame] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const credits = useMemo(() => resolutionCost[resolution] * duration, [duration, resolution]);

  async function loadTasks() {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    const json = await response.json();
    setTasks(json.tasks ?? []);
  }

  useEffect(() => {
    loadTasks();
    const timer = window.setInterval(loadTasks, 5000);
    return () => window.clearInterval(timer);
  }, []);

  function onFiles(value: FileList | null) {
    if (!value) return;
    const next = [...files, ...Array.from(value)];

    if (mode === "image") {
      setFiles(next.filter((file) => file.type.startsWith("image/")).slice(0, 1));
      return;
    }

    if (mode === "reference") {
      const images = next.filter((file) => file.type.startsWith("image/")).slice(0, 9);
      const videos = next.filter((file) => file.type.startsWith("video/")).slice(0, 3);
      const audios = next.filter((file) => file.type.startsWith("audio/")).slice(0, 3);
      setFiles([...images, ...videos, ...audios]);
    }
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
  }

  async function generate() {
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("mode", mode);
      formData.append("prompt", prompt);
      formData.append("resolution", resolution);
      formData.append("duration", String(duration));
      formData.append("aspectRatio", aspectRatio);
      formData.append("realPerson", String(realPerson));
      formData.append("returnLastFrame", String(returnLastFrame));
      files.forEach((file) => formData.append("files", file));

      const response = await fetch("/api/generate", {
        method: "POST",
        body: formData
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error ?? json.task?.error ?? "生成に失敗しました。");
      }

      setPrompt("");
      setFiles([]);
      await loadTasks();
    } catch (error) {
      alert(error instanceof Error ? error.message : "生成に失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  const canGenerate =
    prompt.trim().length > 0 &&
    (mode === "text" || files.length > 0) &&
    !loading;

  return (
    <main className="min-h-screen overflow-hidden bg-ink">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute -top-32 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-violet/20 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-96 w-96 rounded-full bg-cyan/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-5 md:px-8">
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-cyan to-violet shadow-glow">
              <Clapperboard size={24} />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-white/40">AI VIDEO STUDIO</p>
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Seedance Black</h1>
            </div>
          </div>
          <button className="grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-white/5">
            <Moon size={20} />
          </button>
        </header>

        <section className="mb-6 text-center md:mb-8">
          <p className="mb-3 text-sm text-gold">Seedance 2.0 workflow</p>
          <h2 className="gold-text mx-auto max-w-3xl text-4xl font-bold tracking-tight md:text-6xl">
            黒背景で、迷わず生成する。
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-white/55 md:text-base">
            テキスト、画像1枚、複数リファレンスを分けて扱う動画生成UI。
            素材を入れて、設定を決めて、生成タスクを走らせます。
          </p>
        </section>

        <div className="grid flex-1 gap-5 lg:grid-cols-[1fr_380px]">
          <section className="premium-border rounded-[2rem] bg-panel/90 p-4 shadow-glow md:p-6">
            <div className="hide-scrollbar mb-5 flex gap-2 overflow-x-auto rounded-2xl border border-white/10 bg-black/30 p-1">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => {
                    setMode(tab.key);
                    setFiles([]);
                  }}
                  className={[
                    "flex shrink-0 items-center gap-2 rounded-xl px-4 py-3 text-sm transition",
                    mode === tab.key
                      ? "bg-white text-black"
                      : "text-white/45 hover:bg-white/5 hover:text-white"
                  ].join(" ")}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="mb-5 rounded-[1.5rem] border border-white/10 bg-black/35 p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-white/35">Mode</p>
                  <h3 className="mt-2 text-2xl font-semibold">{modeTitle(mode)}</h3>
                  <p className="mt-2 text-sm leading-6 text-white/45">{modeHint(mode)}</p>
                </div>
                <div className="rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs text-gold">
                  Seedance 2.0
                </div>
              </div>

              {mode !== "text" && (
                <div className="mb-4">
                  <input
                    ref={inputRef}
                    type="file"
                    multiple={mode === "reference"}
                    accept={acceptForMode(mode)}
                    className="hidden"
                    onChange={(event) => onFiles(event.target.files)}
                  />
                  <button
                    onClick={() => inputRef.current?.click()}
                    className="grid min-h-44 w-full place-items-center rounded-3xl border border-dashed border-white/20 bg-white/[0.03] p-6 text-center transition hover:border-gold/60 hover:bg-gold/5"
                  >
                    <div>
                      <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-white/5">
                        <Upload />
                      </div>
                      <p className="font-medium">素材をアップロード</p>
                      <p className="mt-2 text-sm text-white/40">
                        {mode === "image"
                          ? "png, jpg, jpeg, webp / 1枚"
                          : "画像9枚・動画3本・音声3個まで"}
                      </p>
                    </div>
                  </button>

                  {files.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {files.map((file, index) => (
                        <button
                          key={`${file.name}-${index}`}
                          onClick={() => removeFile(index)}
                          className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70"
                        >
                          {index + 1}. {file.name} ×
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={
                  mode === "reference"
                    ? "@Image1を主人公の見た目、@Video1を動き、@Audio1を音の参考にして..."
                    : mode === "image"
                      ? "アップロードした画像をもとに、作りたい動きを説明してください。"
                      : "テキストを入力し、生成したい内容を説明してください。"
                }
                className="min-h-52 w-full resize-none rounded-3xl border border-white/10 bg-black/45 p-5 text-base leading-7 text-white outline-none transition placeholder:text-white/28 focus:border-gold/50"
              />
            </div>

            <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.035] p-5">
              <button
                onClick={() => setShowDetails((value) => !value)}
                className="mb-4 flex w-full items-center justify-between text-left"
              >
                <span className="text-lg font-semibold">設定</span>
                <ChevronDown className={showDetails ? "rotate-180 transition" : "transition"} />
              </button>

              {showDetails && (
                <div className="space-y-5">
                  <div>
                    <p className="mb-2 text-sm text-white/45">解像度</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(["480p", "720p", "1080p"] as Resolution[]).map((item) => (
                        <button
                          key={item}
                          onClick={() => setResolution(item)}
                          className={[
                            "rounded-2xl border px-4 py-3 text-sm",
                            resolution === item
                              ? "border-white bg-white text-black"
                              : "border-white/10 bg-black/25 text-white/55"
                          ].join(" ")}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="text-white/45">長さ</span>
                      <span>{duration}秒</span>
                    </div>
                    <input
                      type="range"
                      min={5}
                      max={15}
                      value={duration}
                      onChange={(event) => setDuration(Number(event.target.value))}
                      className="w-full accent-violet"
                    />
                  </div>

                  <div>
                    <p className="mb-2 text-sm text-white/45">アスペクト比</p>
                    <div className="grid grid-cols-4 gap-2">
                      {aspectRatios.map((item) => (
                        <button
                          key={item}
                          onClick={() => setAspectRatio(item)}
                          className={[
                            "rounded-2xl border px-3 py-3 text-sm",
                            aspectRatio === item
                              ? "border-white bg-white text-black"
                              : "border-white/10 bg-black/25 text-white/55"
                          ].join(" ")}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>

                  {mode === "reference" && (
                    <div className="grid gap-2">
                      <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/25 px-4 py-3">
                        <span className="text-sm">実在の人物を含む</span>
                        <input
                          type="checkbox"
                          checked={realPerson}
                          onChange={(event) => setRealPerson(event.target.checked)}
                          className="h-5 w-5 accent-violet"
                        />
                      </label>
                      <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/25 px-4 py-3">
                        <span className="text-sm">最後のフレームを返す</span>
                        <input
                          type="checkbox"
                          checked={returnLastFrame}
                          onChange={(event) => setReturnLastFrame(event.target.checked)}
                          className="h-5 w-5 accent-violet"
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              disabled={!canGenerate}
              onClick={generate}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-3xl bg-gradient-to-r from-white via-gold to-violet px-5 py-5 font-semibold text-black shadow-gold transition disabled:cursor-not-allowed disabled:opacity-30"
            >
              {loading ? <Loader2 className="animate-spin" /> : <Sparkles />}
              生成する
              <span className="ml-2 rounded-full bg-black/15 px-3 py-1 text-xs">
                {credits} credits
              </span>
            </button>
          </section>

          <aside className="premium-border rounded-[2rem] bg-panel/90 p-4 md:p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-white/35">Tasks</p>
                <h3 className="mt-1 text-xl font-semibold">生成タスク</h3>
              </div>
              <BadgeCheck className="text-gold" />
            </div>

            <div className="space-y-3">
              {tasks.length === 0 && (
                <div className="rounded-3xl border border-white/10 bg-black/30 p-5 text-sm leading-6 text-white/45">
                  まだタスクはありません。生成するとここに表示されます。
                </div>
              )}

              {tasks.map((task) => (
                <div key={task.id} className="rounded-3xl border border-white/10 bg-black/30 p-4">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {task.mode === "text" && <Wand2 size={15} />}
                        {task.mode === "image" && <ImageIcon size={15} />}
                        {task.mode === "reference" && <Video size={15} />}
                        {task.mode === "text"
                          ? "テキスト"
                          : task.mode === "image"
                            ? "画像"
                            : "リファレンス"}
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/42">{task.prompt}</p>
                    </div>
                    <span
                      className={[
                        "rounded-full px-2.5 py-1 text-[11px]",
                        task.status === "succeeded"
                          ? "bg-emerald-400/15 text-emerald-300"
                          : task.status === "failed"
                            ? "bg-red-400/15 text-red-300"
                            : "bg-white/10 text-white/60"
                      ].join(" ")}
                    >
                      {task.status}
                    </span>
                  </div>

                  <div className="mb-3 grid grid-cols-3 gap-2 text-center text-[11px] text-white/45">
                    <div className="rounded-2xl bg-white/5 px-2 py-2">{task.resolution}</div>
                    <div className="rounded-2xl bg-white/5 px-2 py-2">{task.duration}s</div>
                    <div className="rounded-2xl bg-white/5 px-2 py-2">{task.costCredits}cr</div>
                  </div>

                  {(task.watermarkedUrl || task.outputVideoUrl) && (
                    <video
                      controls
                      src={task.watermarkedUrl ?? task.outputVideoUrl}
                      className="mb-3 aspect-video w-full rounded-2xl bg-black object-cover"
                    />
                  )}

                  {task.error && (
                    <p className="mb-3 rounded-2xl bg-red-500/10 p-3 text-xs leading-5 text-red-200">
                      {task.error}
                    </p>
                  )}

                  {task.outputVideoUrl && (
                    <a
                      href={task.outputVideoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-white/80"
                    >
                      <Download size={16} />
                      開く / 保存
                    </a>
                  )}
                </div>
              ))}
            </div>
          </aside>
        </div>

        <footer className="mt-6 flex flex-wrap items-center justify-center gap-3 text-xs text-white/30">
          <span className="flex items-center gap-2"><AudioLines size={14} /> native audio workflow</span>
          <span>・</span>
          <span>black premium UI</span>
          <span>・</span>
          <span>mobile first</span>
        </footer>
      </div>
    </main>
  );
}
