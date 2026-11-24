// Real app logos where an integration is named (LIBRARY.md "logos"; PHILOSOPHY P15: "icons / logos for the brands atleast
// instead of just the generic icons"). The beta calls no logo service (the original used ai-icon.b3.fun), so the marks the
// kit shows are vendored here as SVG paths from Simple Icons (CC0-1.0; the brands are their owners' trademarks): the
// integrations (GitHub, Slack, Stripe, Linear, Notion, OpenAI) and the runtimes a template names (Python, Node.js,
// Ubuntu, Jupyter), from 15.10.0; and every other branded pack's service (Airtable, arXiv, Discord, Gmail, Google
// Calendar, Drive and Sheets, Jira, Pushbullet, Resend, Wikipedia, Y Combinator for Hacker News), from 16.35.0, the paths
// packages/packs/marks.json carries, with Simple Icons' colours (Actions judge r1, B2: never a generic stand-in).
// The models and services the product pages name (Vision, Render and Infer judge r2, M1): Qwen's mark from Simple Icons
// 16.38.1 (CC0-1.0, slug `qwen`, its colour #6950EF); Firecrawl's flame from Firecrawl's own press kit
// (https://www.firecrawl.dev/brand, "Symbol", /brand/firecrawl-logo.svg, 200 x 284, fetched 2026-11-22; Simple Icons has
// none; no licence is stated, the mark is Firecrawl's trademark, shown to name its API), its one path scaled into the
// 24 px box and centred, shape and "Heat" #FA5D19 unchanged, as its guidelines ask;
// Kokoro (hexgrad's Kokoro-82M voice model) publishes no mark, so its entry is a plain monogram, a geometric K drawn
// here in the ink, not a logo.
// A colour brand keeps its colour; a black mark (GitHub, Notion, OpenAI) takes the ink, so it reads in dark mode too, and
// so does Slack's aubergine, which is too dark to read on a dark tile.

import { useEffect, useState } from "react";
import { IconTile } from "../layout/node-icon-tile";
import { cn } from "../lib/utils";
import { whenLanded } from "./landed";
import "./css/lite.css";
import "./kit.css";

// The names and titles only: the paths load when a mark is first drawn (logo-paths.ts, `useMarks`).
const LOGOS = {
  slack: { title: "Slack" },
  github: { title: "GitHub" },
  stripe: { title: "Stripe" },
  linear: { title: "Linear" },
  notion: { title: "Notion" },
  openai: { title: "OpenAI" },
  python: { title: "Python" },
  nodejs: { title: "Node.js" },
  ubuntu: { title: "Ubuntu" },
  jupyter: { title: "Jupyter" },
  airtable: { title: "Airtable" },
  arxiv: { title: "arXiv" },
  discord: { title: "Discord" },
  gmail: { title: "Gmail" },
  googlecalendar: { title: "Google Calendar" },
  googledrive: { title: "Google Drive" },
  googlesheets: { title: "Google Sheets" },
  ycombinator: { title: "Y Combinator" },
  jira: { title: "Jira" },
  pushbullet: { title: "Pushbullet" },
  resend: { title: "Resend" },
  wikipedia: { title: "Wikipedia" },
  qwen: { title: "Qwen" },
  firecrawl: { title: "Firecrawl" },
  kokoro: { title: "Kokoro" },
  anthropic: { title: "Anthropic" },
  meta: { title: "Meta" },
  deepseek: { title: "DeepSeek" },
  mistralai: { title: "Mistral AI" },
  google: { title: "Google" },
  googlegemini: { title: "Google Gemini" },
  kimi: { title: "Kimi" },
  nvidia: { title: "NVIDIA" },
} as const;

export type BrandName = keyof typeof LOGOS;

export const BRANDS = Object.keys(LOGOS) as BrandName[];

/**
 * The first-party packs whose service the kit has a logo for (packages/packs/marks.json's brand marks, and Slack): one
 * map, so every area draws a pack by its service's logo (PackTile, a step, a source).
 */
export const PACK_BRANDS: Readonly<Record<string, BrandName>> = {
  "io.b3os/airtable": "airtable",
  "io.b3os/arxiv": "arxiv",
  "io.b3os/discord": "discord",
  "io.b3os/github": "github",
  "io.b3os/gmail": "gmail",
  "io.b3os/google-calendar": "googlecalendar",
  "io.b3os/google-drive": "googledrive",
  "io.b3os/google-sheets": "googlesheets",
  "io.b3os/hacker-news": "ycombinator",
  "io.b3os/jira": "jira",
  "io.b3os/linear": "linear",
  "io.b3os/notion": "notion",
  "io.b3os/pushbullet": "pushbullet",
  "io.b3os/resend": "resend",
  "io.b3os/stripe": "stripe",
  "io.b3os/wikipedia": "wikipedia",
  "io.b3os/slack": "slack",
};

/** A pack's brand, when the kit has its logo: "io.b3os/discord" is Discord; undefined for a pack with no brand. */
export function packBrand(id: string | null | undefined): BrandName | undefined {
  return id ? PACK_BRANDS[id] : undefined;
}

/**
 * The one table from a model id to its maker's mark (B3-7148, details brief decision 2), first match wins:
 * - the maker's own prefix, as the B3IQ gateway and Hugging Face name models ("openai/gpt-5.1-mini",
 *   "meta-llama/Llama-3.1-8B"): it wins over the family, so NVIDIA's Nemotron tune of Llama is NVIDIA's;
 * - then the family in the name, after any prefix ("b3os/qwen3.5-9b" is Qwen's, "kokoro-82m" Kokoro's monogram).
 * A maker with no mark the kit may vendor (Zhipu's GLM, BAAI's BGE) and any id not listed here draw no mark: a wrong
 * maker's mark is worse than none.
 */
export const MODEL_BRANDS: readonly (readonly [RegExp, BrandName])[] = [
  [/^openai\//i, "openai"],
  [/^anthropic\//i, "anthropic"],
  [/^(meta|meta-llama|facebook)\//i, "meta"],
  [/^(qwen|alibaba|alibaba-cloud)\//i, "qwen"],
  [/^(deepseek|deepseek-ai)\//i, "deepseek"],
  [/^(mistral|mistralai)\//i, "mistralai"],
  [/^google\/gemini/i, "googlegemini"],
  [/^google\//i, "google"],
  [/^(moonshot|moonshotai)\//i, "kimi"],
  [/^nvidia\//i, "nvidia"],
  [/(^|\/)qwen/i, "qwen"],
  [/(^|\/)kokoro/i, "kokoro"],
  [/(^|\/)claude/i, "anthropic"],
  [/(^|\/)(gpt-|chatgpt|o[134](-|$)|text-embedding-3|whisper)/i, "openai"],
  [/(^|\/)llama/i, "meta"],
  [/(^|\/)deepseek/i, "deepseek"],
  [/(^|\/)(mistral|mixtral|codestral|ministral|magistral|pixtral|devstral)/i, "mistralai"],
  [/(^|\/)gemini/i, "googlegemini"],
  [/(^|\/)gemma/i, "google"],
  [/(^|\/)(kimi|moonshot)/i, "kimi"],
  [/(^|\/)nemotron/i, "nvidia"],
];

/** A model's maker's mark, when the kit has it; undefined for any other model (never a guess). */
export function modelBrand(id: string | null | undefined): BrandName | undefined {
  return id ? MODEL_BRANDS.find(([re]) => re.test(id.trim()))?.[1] : undefined;
}

/** Each brand's name as it is written ("Node.js"). */
export const BRAND_TITLES = Object.fromEntries(BRANDS.map((b) => [b, LOGOS[b].title])) as Record<BrandName, string>;

type Marks = typeof import("./logo-paths").default;
let marksIn: Marks | null = null;
let marksLoad: Promise<Marks> | null = null;
const loadMarks = () => {
  marksLoad ??= import("./logo-paths").then((mod) => {
    marksIn = mod.default;
    return marksIn;
  });
  return marksLoad;
};

/**
 * Every mark's path and colour, once loaded: the first mark drawn loads them all (about 8 KiB gz), once the page has
 * landed (landed.ts), so they never share the network with the page's own code.
 */
function useMarks(): Marks | null {
  const [marks, setMarks] = useState(marksIn);
  useEffect(() => {
    if (marks) return;
    let live = true;
    void whenLanded()
      .then(loadMarks)
      .then((m) => {
        if (live) setMarks(m);
      });
    return () => {
      live = false;
    };
  }, [marks]);
  return marks;
}

/**
 * A brand's mark, `size` px square, labelled with the brand's name unless `decorative`; `mono` draws it in the text's
 * colour instead of the brand's (a model's maker beside its name).
 */
export function BrandLogo({
  name,
  size = 16,
  decorative = false,
  mono = false,
  className,
}: {
  name: BrandName;
  size?: number;
  decorative?: boolean;
  mono?: boolean;
  className?: string;
}) {
  const marks = useMarks();
  const m = marks?.[name];
  // The box is the mark's from the first frame (its size, its name); the path fills it when the marks are in.
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      // Mono: the text's own colour (kit.css gives .kit-logo the ink; beside grey numbers that read darker than them).
      style={mono ? { color: "inherit" } : m ? { color: m.color } : undefined}
      className={cn("kit-logo", `kit-logo--${name}`, className)}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : LOGOS[name].title}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      {m ? <path d={m.path} /> : null}
    </svg>
  );
}

/** The mark on the original's embossed plate (IconTile), where an integration stands for a row, a step or a source. */
export function LogoTile({
  name,
  size = "xs",
  className,
}: {
  name: BrandName;
  size?: "xs" | "sm";
  className?: string;
}) {
  return (
    <IconTile size={size} className={cn("kit-logo-tile", className)}>
      <BrandLogo name={name} size={size === "sm" ? 20 : 16} />
    </IconTile>
  );
}

/**
 * A model's maker's mark beside the model's name (B3-7148): monochrome, in the text's colour, `size` px (14 to 16),
 * decorative (the name beside it says the model). Nothing for a model the table does not map; its paths load after
 * the page has landed, like every mark.
 */
export function ModelMark({
  model,
  size = 14,
  className,
}: {
  model: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const brand = modelBrand(model);
  if (!brand) return null;
  return <BrandLogo name={brand} size={size} mono decorative className={cn("kit-model-mark shrink-0", className)} />;
}
