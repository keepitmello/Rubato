import "@git-diff-view/react/styles/diff-view-pure.css"
import { DiffModeEnum, DiffView } from "@git-diff-view/react"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { fetchGitView } from "../lib/api"
import type { ConversationEntry, RegisteredHost } from "../lib/types"

export default function ArtifactBrowser({ host, liveSessionId, images }: { host: RegisteredHost; liveSessionId: string; images: readonly Extract<ConversationEntry, { kind: "image" }>[] }) {
  const [tab, setTab] = useState<"diff" | "files" | "images">("diff")
  const [mode, setMode] = useState<"unified" | "split">("unified")
  const git = useQuery({ queryKey: ["git", host.hostId, liveSessionId], queryFn: () => fetchGitView(host, liveSessionId) })
  return <>
    <div className="tool-tabs" role="tablist" aria-label="작업 결과">
      <button role="tab" aria-selected={tab === "diff"} onClick={() => setTab("diff")}>변경점</button>
      <button role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>파일</button>
      <button role="tab" aria-selected={tab === "images"} onClick={() => setTab("images")}>이미지</button>
    </div>
    {git.isLoading ? <div className="skeleton" aria-label="작업 결과를 불러오는 중" /> : git.isError ? <div className="error-box" role="alert"><strong>작업 결과를 불러오지 못했어요.</strong><p>연결을 확인한 뒤 다시 시도하세요.</p><button className="secondary" onClick={() => void git.refetch()}>다시 시도</button></div> : null}
    {tab === "diff" && git.data ? <div role="tabpanel">
      <div className="row spread" style={{ margin: "8px 0 12px" }}><span className="meta">{git.data.summary}</span><button className="secondary" onClick={() => setMode((value) => value === "unified" ? "split" : "unified")}>{mode === "unified" ? "나란히 보기" : "한 줄로 보기"}</button></div>
      <DiffView data={{ ...git.data.diff, hunks: [...git.data.diff.hunks] }} diffViewMode={mode === "unified" ? DiffModeEnum.Unified : DiffModeEnum.Split} diffViewWrap diffViewHighlight={false} />
    </div> : null}
    {tab === "files" && git.data ? <div role="tabpanel" className="surface">{git.data.files.length > 0 ? git.data.files.map((file) => <div className="settings-row" key={file.path}><strong>{file.path.split("/").at(-1)}</strong><div className="meta">{file.path.split("/").slice(0, -1).join("/")} · {file.status}</div></div>) : <div className="empty"><strong>바뀐 파일이 없어요.</strong></div>}</div> : null}
    {tab === "images" ? <div role="tabpanel" className="gallery">{images.length > 0 ? images.map((image) => <figure key={image.id}><img src={image.url} alt={image.alt} /><figcaption className="meta">{image.alt}</figcaption></figure>) : <div className="empty"><strong>이 세션에 이미지가 없어요.</strong></div>}</div> : null}
  </>
}
