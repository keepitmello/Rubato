/**
 * Rubato's sessions in the Usage page's token and cost history, each under its model's vendor.
 *
 * Rubato's sessions are Pi logs (~/.rubato-pi/agent/sessions, read by T3's Pi reader), whose
 * models read `<provider>/<model>`. T3 takes one transcript directory as one provider's source,
 * in its scan cache and in the clients' merge alike, so the records keep Pi's identity while they
 * are read and cached, and only the summary splits the directory: one source per vendor, holding
 * that vendor's records under the bare model name, with its own session count. Providers without
 * a T3 usage kind stay under Pi.
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

/**
 * A Pi record already cached under a bare model name (a parse that dropped the provider) still
 * tells its vendor by the model's family.
 */
const BARE_FAMILIES: ReadonlyArray<readonly [string, UsageProviderKind]> = [
  ["claude-", "claude"],
  ["gpt-", "codex"],
  ["grok-", "grok"],
  ["gemini-", "antigravity"],
];

export function rubatoVendorRecord(record: UsageRecord): UsageRecord {
  if (record.provider !== "pi") return record;
  const slash = record.model.indexOf("/");
  if (slash === -1) {
    const family = BARE_FAMILIES.find(([prefix]) => record.model.startsWith(prefix));
    return family === undefined ? record : { ...record, provider: family[1] };
  }
  const vendor = VENDOR_KINDS.get(record.model.slice(0, slash));
  if (vendor === undefined) return record;
  const model = record.model.slice(slash + 1);
  return { ...record, provider: vendor, model, rateModel: record.rateModel ?? model };
}

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
      for (const record of file.records) {
        const mapped = rubatoVendorRecord(record);
        const list = records.get(mapped.provider);
        if (list) list.push(mapped);
        else records.set(mapped.provider, [mapped]);
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
