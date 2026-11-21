/**
 * Rubato's sessions in the Usage page's token and cost history, each under its model's vendor.
 *
 * Rubato's sessions are Pi logs (~/.rubato-pi/agent/sessions, read by T3's Pi reader), whose
 * models read `<provider>/<model>`. T3 takes one transcript directory as one provider's source,
 * in its scan cache and in the clients' merge alike, so the records keep Pi's identity while they
 * are read and cached, and only the summary splits the directory: one source per vendor, holding
 * that vendor's records under the model's own name, with its own session count. A provider that
 * is only a road to another maker's model (Vertex, OpenGateway) counts under the model's maker.
 *
 * @module usage/rubatoVendorUsage
 */
import type { UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

/** Rubato provider id → the usage kind its records count under. */
const VENDOR_KINDS: ReadonlyMap<string, UsageProviderKind> = new Map<string, UsageProviderKind>([
  ["anthropic", "claude"],
  ["openai-codex", "codex"],
  ["xai", "grok"],
  ["google-antigravity", "antigravity"],
  ["cursor", "cursor"],
]);

/** A model reached through a provider that is not its maker counts under its maker. */
const MAKER_FAMILIES: ReadonlyArray<readonly [string, UsageProviderKind]> = [
  ["claude-", "claude"],
  ["gpt-", "codex"],
  ["grok-", "grok"],
  ["gemini-", "gemini"],
  ["deepseek-", "deepseek"],
];

/**
 * A Pi record cached under a bare model name, from a parse that dropped the provider, came
 * through Antigravity when it is a Gemini model.
 */
const BARE_FAMILIES: ReadonlyArray<readonly [string, UsageProviderKind]> = [
  ...MAKER_FAMILIES.filter(([prefix]) => prefix !== "gemini-"),
  ["gemini-", "antigravity"],
];

const familyOf = (
  model: string,
  families: ReadonlyArray<readonly [string, UsageProviderKind]>,
): UsageProviderKind | undefined => families.find(([prefix]) => model.startsWith(prefix))?.[1];

export function rubatoVendorRecord(record: UsageRecord): UsageRecord {
  if (record.provider !== "pi") return record;
  const slash = record.model.indexOf("/");
  if (slash === -1) {
    const family = familyOf(record.model, BARE_FAMILIES);
    return family === undefined ? record : { ...record, provider: family };
  }
  // "<provider>/<model>", where an OpenGateway model is itself "<maker>/<model>".
  const model = record.model.slice(record.model.lastIndexOf("/") + 1);
  const vendor =
    VENDOR_KINDS.get(record.model.slice(0, slash)) ?? familyOf(model, MAKER_FAMILIES);
  if (vendor === undefined) return record;
  return { ...record, provider: vendor, model, rateModel: record.rateModel ?? model };
}

/** The vendor most of a file's records went to, which takes its tool and summary records. */
function mainKind(records: ReadonlyMap<UsageProviderKind, readonly UsageRecord[]>) {
  let main: UsageProviderKind | undefined;
  for (const [kind, list] of records) {
    if (kind !== "pi" && (main === undefined || list.length > records.get(main)!.length)) main = kind;
  }
  return main;
}

/** Pi's name for usage without a model: tool results, compaction and branch summaries. */
const TOOLS_MODEL = "Tools/summaries";

interface SourceFile {
  readonly path: string;
  readonly records: readonly UsageRecord[];
  readonly malformedRecords: number;
}

/**
 * Each Pi directory becomes Pi's source plus one source per vendor with records there; every
 * other directory passes through. `files[i]` belongs to `dirs[i]` on both sides.
 */
export function splitRubatoVendorSources<
  Dir extends { readonly provider: UsageProviderKind },
  File extends SourceFile,
>(
  dirs: ReadonlyArray<Dir>,
  files: ReadonlyArray<ReadonlyArray<File>>,
): { readonly dirs: ReadonlyArray<Dir>; readonly files: ReadonlyArray<ReadonlyArray<File>> } {
  const outDirs: Dir[] = [];
  const outFiles: File[][] = [];
  for (const [index, dir] of dirs.entries()) {
    const dirFiles = files[index] ?? [];
    if (dir.provider !== "pi") {
      outDirs.push(dir);
      outFiles.push([...dirFiles]);
      continue;
    }
    const byKind = new Map<UsageProviderKind, File[]>([["pi", []]]);
    for (const file of dirFiles) {
      const records = new Map<UsageProviderKind, UsageRecord[]>();
      const unattributed: UsageRecord[] = [];
      for (const record of file.records) {
        const mapped = rubatoVendorRecord(record);
        if (mapped.provider === "pi" && mapped.model === TOOLS_MODEL) {
          unattributed.push(mapped);
          continue;
        }
        const list = records.get(mapped.provider);
        if (list) list.push(mapped);
        else records.set(mapped.provider, [mapped]);
      }
      // Tool results and summaries carry no model; the session's model paid for them.
      const main = mainKind(records);
      if (main === undefined) {
        if (unattributed.length > 0) records.set("pi", [...(records.get("pi") ?? []), ...unattributed]);
      } else {
        records.get(main)!.push(...unattributed.map((record) => ({ ...record, provider: main })));
      }
      // Pi's source keeps every file, so its scanned, skipped and malformed counts stay whole.
      byKind.get("pi")!.push({ ...file, records: records.get("pi") ?? [] });
      for (const [kind, list] of records) {
        if (kind === "pi") continue;
        const kindFiles = byKind.get(kind) ?? [];
        kindFiles.push({ ...file, records: list, malformedRecords: 0 });
        byKind.set(kind, kindFiles);
      }
    }
    for (const [kind, kindFiles] of byKind) {
      outDirs.push(kind === "pi" ? dir : { ...dir, provider: kind });
      outFiles.push(kindFiles);
    }
  }
  return { dirs: outDirs, files: outFiles };
}
