// Rubato: one picker instance (Rubato) carries models from many vendors, so a model
// row and the closed trigger show that model's vendor glyph and name instead of the
// instance's. Grok and OpenCode glyphs ship as plain data in their provider packages.
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { SVGProps } from "react";
import { AntigravityIcon, ClaudeAI, CursorIcon, type Icon, KiroIcon, OpenAI } from "../Icons";
import { DeepSeekIcon } from "../DeepSeekIcon";
import { GeminiIcon } from "../GeminiIcon";
import { OpenGatewayIcon } from "../OpenGatewayIcon";
import { RubatoIcon } from "../RubatoIcon";
import { ZhipuIcon } from "../ZhipuIcon";
import type { ModelEsque } from "./providerIconUtils";
import { ProviderPackageIcon } from "./ProviderPackageIcon";

function packageIcon(driverKind: string): Icon {
  const icon = providerClients.get(ProviderDriverKind.make(driverKind))?.icon;
  return (props: SVGProps<SVGSVGElement>) =>
    icon ? <ProviderPackageIcon icon={icon} {...props} /> : <RubatoIcon {...props} />;
}
const GrokIcon = packageIcon("grok");
const OpenCodeIcon = packageIcon("opencode");

const VENDOR_ICONS: Record<string, Icon> = {
  "openai-codex": OpenAI,
  anthropic: ClaudeAI,
  xai: GrokIcon,
  "google-antigravity": AntigravityIcon,
  kiro: KiroIcon,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
  "b-ai": DeepSeekIcon,
  opengateway: OpenGatewayIcon,
  nanogpt: ZhipuIcon,
  "google-vertex": GeminiIcon,
  google: GeminiIcon,
};
const VENDOR_LABELS: Record<string, string> = {
  "openai-codex": "OpenAI",
  anthropic: "Claude",
  xai: "xAI",
  "google-antigravity": "Antigravity",
  kiro: "Kiro",
  cursor: "Cursor",
  opencode: "OpenCode",
  "b-ai": "b.ai",
  opengateway: "OpenGateway",
  nanogpt: "NanoGPT",
  "google-vertex": "Vertex AI",
  google: "Gemini API",
};

export function vendorForModel(model: Pick<ModelEsque, "slug" | "subProvider">): string | undefined {
  const sub = (model.subProvider ?? "").toLowerCase();
  if (sub && VENDOR_ICONS[sub]) return sub;
  const slug = model.slug.toLowerCase();
  const provider = slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : "";
  return provider && VENDOR_ICONS[provider] ? provider : undefined;
}

/** The model's vendor glyph; a Rubato model of no known vendor gets the Rubato mark. */
export function iconForProviderModel(
  driverKind: ProviderDriverKind,
  model: Pick<ModelEsque, "slug" | "subProvider">,
): Icon | null {
  // 게이트웨이(b.ai·OpenGateway)는 길일 뿐이라 DeepSeek 모델에는 DeepSeek 로고를 쓴다.
  if (model.slug.toLowerCase().includes("deepseek")) return DeepSeekIcon;
  if (model.slug.toLowerCase().includes("gemini")) return GeminiIcon;
  const vendor = vendorForModel(model);
  return (vendor ? VENDOR_ICONS[vendor] : undefined) ?? (driverKind === "rubato-pi" ? RubatoIcon : null);
}

export function subProviderLabel(
  subProvider: string,
  model?: Pick<ModelEsque, "slug" | "subProvider">,
): string {
  const vendor = vendorForModel(model ?? { slug: "", subProvider });
  return VENDOR_LABELS[vendor ?? ""] || VENDOR_LABELS[subProvider.toLowerCase()] || subProvider;
}
