#!/usr/bin/env node
import { startSpeedDataUpload } from "../src/speed-data-auto.mjs";

const result = startSpeedDataUpload();
if (result.status === "started") {
  console.log("가명 속도 수집을 백그라운드에서 확인해요. GitHub 쓰기 권한이 없으면 보내지 않아요.");
} else if (result.reason === "start_failed" || result.reason === "spawn_failed") {
  console.error("가명 속도 수집을 시작하지 못했어요. 업데이트는 완료돼요.");
}
