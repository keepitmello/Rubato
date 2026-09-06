#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { simulate } from "./lib/context-cost-model.mjs";

export function runSimulation(trace, config) {
  if (trace.formatVersion !== 1 || !Array.isArray(config.experiments)) throw new Error("기록 또는 설정 형식이 잘못됐어요.");
  const results = [];
  const warnings = [...(trace.warnings ?? [])];
  for (const experiment of config.experiments) {
    const { label, prices, common = {}, thresholds, scenarios } = experiment;
    if (trace.modelKey && experiment.modelKeys && !experiment.modelKeys.includes(trace.modelKey)) {
      warnings.push(`${label}: 다른 모델 기록에 가격을 적용했어요. 실제 모델의 토큰 수나 검색 행동으로 해석하지 마세요.`);
    }
    if (!label || !Array.isArray(thresholds) || !Array.isArray(scenarios)) throw new Error("실험 설정에 이름·임계점·시나리오가 필요해요.");
    for (const thresholdTokens of thresholds) for (const scenario of scenarios) {
      try { results.push({ experiment: label, scenario: scenario.name,
        ...simulate(trace, { ...common, ...scenario, thresholdTokens }, prices) }); }
      catch (error) { results.push({ experiment: label, scenario: scenario.name, thresholdTokens, invalid: error.message }); }
    }
  }
  return { formatVersion: 1, createdAt: new Date().toISOString(),
    meaning: "고정 작업량과 명시한 가정 아래의 API 환산 비용이에요. 실제 청구액·구독 소진율·행동 품질을 예측한 값은 아니에요.",
    traceWarnings: [...new Set(warnings)], results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error("사용법: node context-cost-simulate.mjs TRACE.json CONFIG.json OUTPUT.json");
    const result = runSimulation(JSON.parse(readFileSync(args[0], "utf8")), JSON.parse(readFileSync(args[1], "utf8")));
    writeFileSync(args[2], JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const valid = result.results.filter(r => !r.invalid);
    console.log(`유효한 계산 ${valid.length}개, 적용 불가능한 후보 ${result.results.length - valid.length}개를 저장했어요.`);
    console.log("같은 실험·가정끼리 비교해 주세요. 서로 다른 원문 재입력 가정을 섞어 최저가 하나를 고르면 안 돼요.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
