// server.mjs — 단일 파일 완전본 (프런트 변경 불필요)
// - /api/read, /api/ai 모두 수신 (기존 프런트 그대로 동작)
// - 프롬프트 요약/트렁케이트 안 함 (요청 받은 그대로 전달)
// - 예산 가드(미설정=무제한), 연타 방지, 간단 캐시, 일일 사용량(UTC 자정 리셋)
// - USE_OPENAI=false 시 테스트 모드(과금/외부호출 차단)
// - /healthz 헬스 체크, /api/usage?key=ADMIN_KEY 개인 확인용

import express from "express";
import cors from "cors";
import OpenAI from "openai";

// ================== 기본 서버 ==================
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

// 신뢰 가능한 프록시 헤더(IP 추적용)
app.set("trust proxy", true);

// 인스턴스/레이트리밋 보조 유틸
const INSTANCE = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || "local";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 분당 호출 간격(우발 중복 완화)
const MIN_GAP_MS = 300;
let lastCallTs = 0;

// 최근 60초 토큰 추적(우리 측 관측치)
const last60s = []; // [{ ts, tokens }]
function track60s(tokensNow){
  const now = Date.now();
  last60s.push({ ts: now, tokens: tokensNow });
  while (last60s.length && now - last60s[0].ts > 60_000) last60s.shift();
  const used = last60s.reduce((s, x) => s + x.tokens, 0);
  console.log("[MY 60s]", { used });
  return used;
}

app.get("/healthz", (_, res) => res.status(200).send("ok"));
app.get("/", (_, res) => res.status(200).send("OK"));

// ================== ENV/설정 ==================
const AI_ON = String(process.env.USE_OPENAI ?? "true") === "true"; // 기본 on
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // /api/usage 보호키(선택)

// 예산(USD) — 미설정/NaN이면 무제한
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD) || 1;

// 모델/토큰 상한 (상한은 환경변수로만 제어; 기본은 1200)
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS) || 3000;

// 단가(1M tokens 기준) — gpt-4o-mini 기본값
const PRICE_IN_PER_M = Number(process.env.PRICE_IN_PER_M ?? 0.15);   // 입력 $/1M tok
const PRICE_OUT_PER_M = Number(process.env.PRICE_OUT_PER_M ?? 0.60); // 출력 $/1M tok

// 일일 사용량(UTC 기준 자정 리셋)
const dayUsage = { day: utcDay(), tokens: 0, calls: 0, spent: 0 };
function utcDay() { return new Date().toISOString().slice(0, 10); }
function rollDay() {
  const d = utcDay();
  if (dayUsage.day !== d) {
    dayUsage.day = d; dayUsage.tokens = 0; dayUsage.calls = 0; dayUsage.spent = 0;
  }
}

// 간단 캐시 (3일)
const CACHE_TTL = 1000 * 60 * 60 * 24 * 3;
const LRU = new Map();
const now = () => Date.now();
function setCache(key, val, ttl = CACHE_TTL) { LRU.set(key, { val, exp: now() + ttl }); }
function getCache(key) { const h = LRU.get(key); if (!h) return null; if (now() > h.exp) { LRU.delete(key); return null; } return h.val; }
const PROMPT_VER = "no-dup-body-v3";
function cacheKeyOf({ method, primary, relating, question }) {
  const hex = `${primary?.number ?? ''}-${relating?.number ?? ''}`;
  return `${PROMPT_VER}|${method || ''}|${hex}|${(question || '').trim()}`;
}

// 연타 방지
let inflight = false;

// OpenAI 클라이언트
const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ================== 공통 유틸 ==================
function costUSD(inTok = 0, outTok = 0) {
  const perTokIn = PRICE_IN_PER_M / 1_000_000;  // $/token
  const perTokOut = PRICE_OUT_PER_M / 1_000_000; // $/token
  return +(inTok * perTokIn + outTok * perTokOut);
}
function parseJsonFromText(txt = "{}") {
  const s = txt.indexOf("{");
  const e = txt.lastIndexOf("}");
  if (s < 0 || e < 0 || e < s) return {};
  try { return JSON.parse(txt.slice(s, e + 1)); } catch { return {}; }
}

// Structured Outputs 스키마 (프론트 기존 형태 유지)
const schema = {
  name: "iching_reading",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reading: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary:  { type: "string" },
          analysis: { type: "string", minLength: 1000, maxLength: 2000 },
          advice:   { type: "string" },
          cautions: { type: "string" },
          timing:   { type: "string" },
          score:    { type: "number" },
          tags:     { type: "array", items: { type: "string" } },
          line_readings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                line:    { type: "number" },
                meaning: { type: "string" }
              },
              required: ["line", "meaning"]
            }
          }
        },
        required: ["summary","analysis","advice","cautions","timing","score","tags","line_readings"]
      },

      // ✅ 새로 추가: 준수 메타
      meta: {
        type: "object",
        additionalProperties: false,
        properties: {
          rule_ok:   { type: "boolean" },
          violations:{ type: "array", items: { type: "string" } }
        },
        required: ["rule_ok", "violations"]
      }
    },
    required: ["reading","meta"] // ← 여기도 업데이트
  }
};

// 시스템 프롬프트 — 길이 제한/요약 지시 없음
const systemPrompt = `

당신은 '주역 점관(占官)'입니다. 한국어 존댓말로 답하세요.

[출력 분리/중복 금지]
- analysis(본문)는 해석 서술만 담고, 절대 다음을 포함하지 말 것: "조언:", "주의:", "금기:", "타이밍:", "길흉 점수", 숫자 점수 표기.
- advice, cautions, timing, score는 각각 해당 필드에만 작성한다(본문에 재진술 금지).
- 변효 상세는 line_readings에만 쓰고, analysis에는 통합 요약만 쓴다(문장·표현 중복 금지).

[analysis 구성(문단)]
1) 한줄 핵심(질문 맥락 반영)
2) 괘상 분석: 상괘/하괘의 상징, 卦辭 및 爻辭 핵심구 「…」 2~4개 인용+풀이
   +십익 및 기타 주석서의 내용 추가 인용+풀이
3) 사용자 질문 맥락으로 의미 전개(예시 1개)
4) 변효를 통합 해석하여 line_readings의 요지를 1문단으로 종합(중복 서술 금지)
5) 전개-장애-반전의 3막 서사로 ‘흐름’ 묘사
6) 2문장 결론(다음 행동 방향 암시; 구체적 조언은 advice에 분리)

[근거 텍스트]
- 卦辭·爻辭·象傳·彖傳·文言傳·說卦傳·序卦傳·雜卦傳(원문 핵심구 “「…」” 인용+풀이 필수)

[해석 절차]
1) 요약 1문장: 길흉 판단(예시: 정말 길하게 잘 나왔다. 이건 좀 난감하다. [질문에 대해] 그러면 안된다. 등) + 본괘 성격과 변괘 방향(卦辭의 핵심 어구로).
2) 본괘 판독: 卦辭 핵심구와 상전 등에서 2~4개를 「…」로 인용+풀이(6~10문장).
3) 변효: (analysis에는) 변효들의 공통 흐름을 효사, 상전을 인용하여 1~2문단으로 종합.
   각 변효의 상세 판독은 **line_readings 필드에만** 작성한다.
4) 통합 결론: 본괘→변효→변괘 흐름을 한 단락으로 정리(다음 행동의 **방향성**만 암시).

[필드 채우기]
- advice: 卦辭/爻辭/象傳 근거 행동형 3–5개(번호/불릿 OK)
- cautions: 피해야 할 2–3개
- timing: 시점/계절/방위
- score: 0–10점(0.5 단위, 근거 한 줄은 본문이 아닌 score 산정 메모에 불가)

[표현 규칙]
- 상징·징조 어휘 사용(예: 「利涉大川」 ‘큰 물을 건넘’→시기·경로 돌파), 심리치유/자기계발 어휘 금지.
- 각 판단 옆에 근거 원문을 「…」로 붙이고, 원문 및 한자를 사용할 시 한글 독음 및 뜻을 병기할 것.
- 중언부언/문장 반복 금지. 전체 분량은 1200~1500자.
- 모든 해석·조언은 철저하게 점괘 내용 그대로 작성할 것.
- 길흉점수(0~10, 0.5 단위): 대길 9–10, 길 7–8.5, 소길 6–6.5, 미지 5±0.5, 소흉 3–4.5, 흉 1–2.5, 대흉 0–1.
  ‘凶/吝/悔’·불리 문구가 우세하면 5 이하로 내릴 것. 극단값(0~1, 9~10)도 허용.
- 조언 3~5개는 전부 爻辭/象傳에 앵커.
- 구체적인 질문(가령 "무엇을 하면 좋을까?" 식의 질문)에는 구체적으로 답하기(예: 구체적인 식사메뉴, 활동, 사고방식 등).
- 운세를 묻는 질문에는 구체적인 항목을 제시할 것(예: 인간관계, 금전, 건강, 사업 등).
`;

// ================== 개인용 조회 ==================
app.get("/api/usage", (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  rollDay();
  res.json({ ok: true, day: dayUsage.day, limits: { tokens: 200_000, requests: 200 }, used: { tokens: dayUsage.tokens, requests: dayUsage.calls, usd: +dayUsage.spent.toFixed(6) }, remaining: { tokens: Math.max(0, 200_000 - dayUsage.tokens), requests: Math.max(0, 200 - dayUsage.calls) }, reset_hint: "매일 KST 09:00 (UTC 00:00)" });
});

// ================== 핵심 라우트 ==================
app.post(["/api/read", "/api/ai"], async (req, res) => {
  console.log(`[HIT ${INSTANCE}] /api/read`, new Date().toISOString(), "from", (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString());

  if (!AI_ON) {
    console.warn("[STUB MODE] USE_OPENAI=false");
    return res.json({ ok: true, source: "stub", reading: { analysis: "테스트 모드: OpenAI 호출 없이 기본 흐름만 확인합니다.", score: 5, line_readings: ["기본 응답입니다."] } });
  }

  if (inflight) {
    console.warn("[BLOCK] inflight");
    return res.status(429).json({ ok: false, error: "이미 처리 중입니다." });
  }
  inflight = true;

  const { question = "", method = "coin", primary = {}, relating = {}, changingLines = [] } = req.body || {};
  const payload = { question, method, primary, relating, changingLines };
  console.log("[REQ]", JSON.stringify(payload));

  // 캐시
  const key = cacheKeyOf(payload);
  const cached = getCache(key);
  if (cached) {
    console.log("[CACHE HIT]", key);
    inflight = false;
    return res.json({ ok: true, source: "cache", ...cached });
  }

  // 예산 확인 (UTC 기준)
  rollDay();
  if (dayUsage.spent >= DAILY_BUDGET_USD) {
    inflight = false;
    console.warn("[BUDGET BLOCK]", { spent: dayUsage.spent, budget: DAILY_BUDGET_USD });
    return res.status(429).json({ ok: false, error: "일일 AI 예산 한도 초과" });
  }

  let parsed;
  try {
    // === OpenAI 호출 (프롬프트 요약/트렁케이트 없음) ===
    const taskPrompt = `사용자 질문과 점괘 JSON이 주어집니다.
- analysis에 1200~1500자 분량의 卦辭·爻辭 기반 본문을 쓰세요.
- 길흉 점수는 0~10점(정수/0.5 단위)입니다.
스키마: { \"reading\": { \"summary\": string, \"analysis\": string, \"advice\": string, \"cautions\": string, \"timing\": string, \"score\": number, \"tags\": string[], \"line_readings\": [{\"line\": number, \"meaning\": string}] } }`;

const messages = [
  { role: "system", content: systemPrompt },
  { role: "user", content: `
질문: ${question ? question : "(없음)"}

JSON 입력:
${JSON.stringify(payload)}
` }
];

    // === OpenAI 호출 (withResponse로 헤더까지 확보) ===
const params = {
  model: OPENAI_MODEL,
  messages,
  max_tokens: OPENAI_MAX_TOKENS,             // (Chat Completions 사용 중)
  response_format: { type: "json_schema", json_schema: schema },

  // ✅ 일탈 억제(권장값)
  temperature: 0.2,
  top_p: 1,
  presence_penalty: 0,
  frequency_penalty: 0,
  seed: 7
};
const { data: cc, response: raw } = await (async function doCall(p, retried = false) {
  // 소프트 쿨다운 — 우발 중복 완화
  const gap = Date.now() - lastCallTs;
  if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
  lastCallTs = Date.now();

  try {
    return await ai.chat.completions.create(p).withResponse();
  } catch (e) {
    if (!retried && e?.response?.status === 429) {
      console.warn("[429] retry once after 65s");
      await sleep(65_000);
      return await doCall(p, true);
    }
    throw e;
  }
})(params);

    console.log("[OPENAI BASE]", process.env.OPENAI_BASE_URL || "(default: api.openai.com)");
    console.log("[RESP ID]", cc?.id);

    const u = cc?.usage || {};
    const inTok  = u.prompt_tokens     ?? u.input_tokens  ?? 0;
    const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
    const totalTok = inTok + outTok;
// 우리 측 최근 60초 누적 관측(중복/외부 사용 감지용)
track60s(totalTok);

    // 일일 집계
    dayUsage.tokens += totalTok;
    dayUsage.calls += 1;
    const $$ = costUSD(inTok, outTok);
    dayUsage.spent += $$;

    console.log("=== USAGE ===", u);
// OpenAI 레이트리밋 헤더 — 실제 TPM 남은치 확인
const limit_tpm  = raw.headers.get("x-ratelimit-limit-tokens");
const remain_tpm = raw.headers.get("x-ratelimit-remaining-tokens");
const reset_tpm  = raw.headers.get("x-ratelimit-reset-tokens");
console.log("[RL]", { limit_tpm, remain_tpm, reset_tpm });
// 매우 낮으면 잠시 대기(사용자 체감 429 완화)
if (Number(remain_tpm || "0") < 2000) {
  console.warn("[ALERT] remain_tpm low — pausing 60s");
  await sleep(60_000);
}
    console.log("[RUN COST] this_call=$", $$.toFixed(6), "spent_today=$", dayUsage.spent.toFixed(6));

    // Structured Outputs → 파싱
    parsed = cc.choices?.[0]?.message?.parsed;
    if (!parsed) parsed = parseJsonFromText(cc.choices?.[0]?.message?.content ?? "{}");
    if (!parsed?.reading) throw new Error("chat.completions: invalid JSON");
    const a = parsed?.reading?.analysis || "";
    const dupHeadings = /(조언:|주의:|금기:|타이밍:|길흉\s*점수|점수\s*:)/;
    if (dupHeadings.test(a)) {
      parsed.meta ||= { rule_ok: true, violations: [] };
      parsed.meta.rule_ok = false;
      parsed.meta.violations = [...(parsed.meta.violations||[]), "analysis_contains_forbidden_headings"];
      // ✅ 본문에서 금지된 헤딩/구역 제거
      let cleaned = a
        .replace(/(?:\n|^)\s*(조언|주의|금기|타이밍)\s*:\s*[^]*?($|\n{2,})/g, "\n")
        .replace(/(?:\n|^)\s*길흉\s*점수\s*[:：][^\n]*$/gm, "")
        .replace(/(?:\n|^)\s*점수\s*[:：][^\n]*$/gm, "");
      // 변효 상세가 line_readings로 이미 넘어왔으면 [n효] 항목을 본문에서 제거
      if ((parsed.reading.line_readings?.length || 0) > 0) {
        cleaned = cleaned.replace(/(?:\n|^)\s*\[\d+효\][^\n]*(?:\n[^\n]*)*/g, "\n");
      }
      parsed.reading.analysis = cleaned.trim();
      }

    // ✅ 반복 문장/문단 자동 정리
    function dedupeParagraphs(text) {
      const paras = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
      const seen = new Set(); const out = [];
      for (const p of paras) {
        const key = p.replace(/\s+/g, " ").toLowerCase().slice(0, 140);
        if (seen.has(key)) continue;
        seen.add(key); out.push(p);
      }
      return out.join("\n\n");
    }
    function dedupeSentences(text) {
      const sents = text.split(/(?<=[.!?。…]|[다요]\.)\s+/); // 한/영 마침표 기준
      const seen = new Set(); const out = [];
      for (const s of sents) {
        const norm = s.replace(/\s+/g, " ").trim().toLowerCase();
        if (!norm) continue;
        if (seen.has(norm)) continue;
        seen.add(norm); out.push(s.trim());
      }
      return out.join(" ");
    }
    let cleaned = dedupeParagraphs(parsed.reading.analysis || "");
    cleaned = dedupeSentences(cleaned);
    // 30자 이상 동일 문장 3회 이상 반복 탐지 → 위반 표기
    if (/([^\n]{30,})\s+\1\s+\1/.test(parsed.reading.analysis || "")) {
      parsed.meta ||= { rule_ok: true, violations: [] };
      parsed.meta.rule_ok = false;
      parsed.meta.violations = [...(parsed.meta.violations||[]), "repetition"];
    }
    parsed.reading.analysis = cleaned.trim();

    const response = { ok: true, source: "openai", ...payload, reading: parsed.reading, meta: parsed.meta };
    setCache(key, response);
    return res.json(response);
  } catch (e) {
    console.warn("[WARN chat.completions]", e?.response?.status, e?.response?.data || e?.message);
    return res.status(500).json({ error: "ai_read_failed", message: "AI 해석을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.", hint: "키 권한, 사용 한도, 서버 로그를 확인해 주세요." });
  } finally {
    inflight = false;
  }
});

// ================== 시작 ==================
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("listening", port));
