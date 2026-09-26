import type {
  RubatoPermissionAction,
  RubatoPermissionId,
  RubatoPermissionStatus,
  RubatoPermissionsState,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PERMISSIONS: Record<RubatoPermissionId, { title: string; description: string }> = {
  screen: {
    title: "화면 기록",
    description: "에이전트가 화면을 찍어서 확인할 때 써요 (screencapture, Peekaboo).",
  },
  accessibility: {
    title: "손쉬운 사용",
    description: "에이전트가 다른 앱의 버튼을 누르고 글자를 입력할 때 써요.",
  },
  fullDisk: {
    title: "전체 디스크 접근",
    description: "메일·메시지·Safari 기록처럼 macOS가 보호하는 폴더를 읽을 때 써요.",
  },
  automation: {
    title: "자동화 (System Events)",
    description:
      "AppleScript로 다른 앱을 조작할 때 써요. Finder·Safari 같은 다른 앱은 처음 쓸 때 macOS가 따로 물어봐요.",
  },
};

const STATUS: Record<RubatoPermissionStatus, { label: string; variant: "success" | "warning" | "info" }> = {
  granted: { label: "허용됨", variant: "success" },
  denied: { label: "꺼져 있음", variant: "warning" },
  unknown: { label: "확인 필요", variant: "info" },
};

// Shown when a permission is off here even though System Settings may show it on.
const STALE_HINT =
  "시스템 설정에는 켜져 있는데 여기서 꺼져 보이면 예전 빌드에 준 권한이에요. '다시 등록'을 누르면 옛 기록을 지우고 새로 물어봐요.";

function hint(id: RubatoPermissionId, status: RubatoPermissionStatus): string | null {
  if (status === "granted") return null;
  if (id === "screen")
    return `허용한 뒤에는 앱을 다시 켜야 이 화면에 반영돼요. ${STALE_HINT}`;
  if (id === "fullDisk")
    return "목록에 Rubato가 없으면 시스템 설정 위에 뜨는 Rubato 아이콘을 목록으로 끌어다 놓으세요.";
  if (id === "automation" && status === "unknown")
    return "전체 디스크 접근이 없으면 상태를 미리 볼 수 없어요. '권한 요청'을 누르면 바로 확인해요.";
  return STALE_HINT;
}

export function RubatoPermissionsSettings() {
  const bridge = window.desktopBridge?.rubatoPermissions;
  const isMac = window.desktopBridge?.getClientPlatform?.() === "darwin";
  const [state, setState] = useState<RubatoPermissionsState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!bridge || !isMac || busyRef.current) return;
    try {
      setState(await bridge.getState());
    } catch (cause) {
      console.warn("Rubato permissions:", cause);
    }
  }, [bridge, isMac]);

  useEffect(() => {
    void refresh();
    // The user grants in System Settings and comes back; check again then,
    // and keep checking while this page is visible.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const act = async (id: RubatoPermissionId | null, action: RubatoPermissionAction) => {
    if (!bridge || busyRef.current) return;
    busyRef.current = true;
    setBusy(`${id ?? "app"}:${action}`);
    setError(null);
    try {
      setState(await bridge.act(id, action));
    } catch (cause) {
      console.warn("Rubato permissions:", cause);
      setError("요청을 처리하지 못했어요. 시스템 설정 → 개인정보 보호 및 보안에서 직접 바꿔 주세요.");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  if (!bridge || !isMac) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="macOS 권한">
          <SettingsRow title="macOS 데스크톱 앱에서만 볼 수 있어요" />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const statusOf = (id: RubatoPermissionId) =>
    state?.items.find((item) => item.id === id)?.status ?? "unknown";

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("rubato-permissions")}
        title="macOS 권한"
        headerAction={
          <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>
            다시 확인
          </Button>
        }
      >
        <SettingsRow
          title="에이전트가 쓰는 권한"
          description="에이전트가 돌리는 도구(screencapture, Peekaboo, osascript)는 Rubato 앱의 권한을 빌려 써요. 여기서 허용하면 모든 세션에 한 번에 적용돼요."
          status={
            state?.signing === "stable"
              ? "이 앱은 고정 서명이라 rubato update·restart 뒤에도 권한이 유지돼요."
              : state?.signing === "adhoc"
                ? "이 앱은 임시 서명이라 다시 빌드할 때마다 권한이 풀려요. 터미널에서 rubato update 를 한 번 돌리면 고정 서명으로 바뀌어요."
                : undefined
          }
        />
        {(Object.keys(PERMISSIONS) as RubatoPermissionId[]).map((id) => {
          const status = statusOf(id);
          const note = state ? hint(id, status) : null;
          return (
            <SettingsRow
              key={id}
              title={
                <span className="flex items-center gap-2">
                  {PERMISSIONS[id].title}
                  {state ? (
                    <Badge size="sm" variant={STATUS[status].variant}>
                      {STATUS[status].label}
                    </Badge>
                  ) : null}
                </span>
              }
              description={PERMISSIONS[id].description}
              status={note ?? undefined}
              control={
                status === "granted" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void act(id, "open")}
                  >
                    시스템 설정
                  </Button>
                ) : (
                  <span className="flex flex-wrap justify-end gap-1.5">
                    <Button
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => void act(id, "request")}
                    >
                      {busy === `${id}:request` ? "여는 중…" : "권한 요청"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void act(id, "reset")}
                    >
                      다시 등록
                    </Button>
                    {id === "screen" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void act(null, "relaunch")}
                      >
                        앱 다시 켜기
                      </Button>
                    ) : null}
                  </span>
                )
              }
            />
          );
        })}
        {error ? <SettingsRow title="오류" description={error} /> : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
