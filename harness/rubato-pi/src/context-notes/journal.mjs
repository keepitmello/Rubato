import { closeSync, fsyncSync, openSync, statSync, readSync } from "node:fs";
import { dirname } from "node:path";

// SessionManager remains the only transcript writer. We merely flush its file
// and verify the appended entry; never append a competing JSONL transcript.
export function flushSessionJournal(manager, entryId) {
  const path = manager.getSessionFile?.();
  if (!path) throw new Error("세션 파일이 없는 실행에서는 복구 가능한 작업 노트를 저장할 수 없어요. 세션 저장을 켜서 실행해 주세요.");
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    // Notes are capped at 1 MB UTF-8. JSON escaping may expand this up to 6 MB.
    const take = Math.min(size, 7_000_000);
    const bytes = Buffer.alloc(take);
    let read = 0;
    while (read < take) {
      const n = readSync(fd, bytes, read, take - read, size - take + read);
      if (!n) throw new Error("세션 파일을 끝까지 읽지 못했어요.");
      read += n;
    }
    const found = bytes.toString("utf8").split("\n").some((line) => {
      try { return JSON.parse(line).id === entryId; } catch { return false; }
    });
    if (!found) throw new Error("새 항목이 세션 파일에 기록되지 않았어요. 이전 문맥은 유지했어요.");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // Persist a newly created file's directory entry on POSIX. Windows does not
  // support opening directories this way; the file flush is still required.
  if (process.platform !== "win32") {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
