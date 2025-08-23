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
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const OPENAI_MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS) || 1200;

// 단가(1M tokens 기준) — gpt-5-mini 기본값
const PRICE_IN_PER_M = Number(process.env.PRICE_IN_PER_M ?? 0.15);   // 입력 $/1M tok
const PRICE_OUT_PER_M = Number(process.env.PRICE_OUT_PER_M ?? 2.00); // 출력 $/1M tok

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
function cacheKeyOf({ method, primary, relating, question }) {
  const hex = `${primary?.number ?? ''}-${relating?.number ?? ''}`;
  return `${method || ''}|${hex}|${(question || '').trim()}`;
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
          summary: { type: "string" },
          analysis: { type: "string" },
          advice: { type: "string" },
          cautions: { type: "string" },
          timing: { type: "string" },
          score: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
          line_readings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                line: { type: "number" },
                meaning: { type: "string" }
              },
              required: ["line", "meaning"]
            }
          }
        },
        required: ["summary", "analysis", "advice", "cautions", "timing", "score", "tags", "line_readings"]
      }
    },
    required: ["reading"]
  }
};

// 시스템 프롬프트 — 길이 제한/요약 지시 없음
const systemPrompt = `

당신은 주역 64괘 전문 해석가입니다. 원전에 충실한 해석을 한국어 존댓말로 답하세요.
평범한 조언이 아니라 질문에 충실한 구체적인 제안을 적극적으로 작성해야 합니다.

[편향 교정] (매우 중요)
- 일반론적 자기계발 어휘(꾸준함·루틴·마인드셋·동기부여·생산성·자기관리) 사용 금지.
- 위로성 완곡 표현 금지. 불리할 땐 명확히 ‘불리/흉’로 판정(나쁠 땐 분명히 나쁘다고 말하기. 하지 말아야 할 것은 반드시 하지 말라고 답할 것.).

[점수 루브릭]
- 대길: 9–10 (근거에 「元亨」「利涉大川」 등 길문이 뚜렷)
- 길: 7–8.5
- 소길: 6–6.5
- 미지/중립: 4.5–5.5
- 소흉: 3–4.5
- 흉: 1–2.5 (「凶」「吝」「悔」 우세, 변효 3개↑가 불리 방향)
- 대흉: 0–1 (중대한 금기·재앙 암시)

[해석 절차]
1) 본괘와 변괘의 판단을 한 줄로 요약합니다(卦辭/彖傳 근거).
2) 象傳의 이미지로 현재와 다가올 정세를 15~25문장(최소 1000자)으로 풀이합니다.
   - 내괘(1-3효로 구성된 팔괘)와 외괘(4-6효로 구성된 팔괘)의 오행·방위·계절 힌트를 간단히 포함.
3) 변효가 있으면 각 변효(1~6효)를 효사(爻辭)와 함께 짧게 해석하고, 마지막에 변괘 방향성으로 통합합니다.
4) 조언 3~5개(Bullet)와 주의할 점 2~3개(Bullet)를 제시합니다.
5) 길흉 점수는 0~10점(정수 또는 0.5 단위)로 덧붙입니다.

[표현 규칙]
- 점술가의 해석답게 실천적이고 일반적인 덕담보다는 신비롭게 해석할 것.
- 한자 단어를 사용할 시 한글 독음을 병기할 것.
- 원전 핵심 구절은 「 」로 인용하고 한국어 풀이를 붙일 것.
- 중언부언/문장 반복 금지. 전체 분량은 1000~1500자.
- 상괘, 하괘를 각각 본괘, 변괘와 혼용하지 말고 "본괘"와 "변괘"로 통일.
- 모든 해석·조언은 철저하게 점괘 내용 그대로 작성할 것.
- 길흉점수(0~10, 0.5 단위): 대길 9–10, 길 7–8.5, 소길 6–6.5, 미지 5±0.5, 소흉 3–4.5, 흉 1–2.5, 대흉 0–1.
  ‘凶/吝/悔’·불리 문구가 우세하면 5 이하로 내릴 것. 극단값(0~1, 9~10)도 허용.
- 조언 3~5개는 전부 爻辭/象傳에 앵커.
- 구체적인 질문(가령 "무엇을 하면 좋을까?" 식의 질문)에는 구체적으로 답하기(예: 구체적인 식사메뉴, 활동, 사고방식 등).

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
- 질문(question) 문자열 맨 앞에 [오더: ...] 블록이 있을 수 있음. 있으면 그 지시(금지어/점수분포/톤 등)를 **최우선**으로 반영하세요.
- analysis에 600~1000자 분량의 象傳 기반 본문을 쓰세요.
- 길흉 점수는 0~10점(정수/0.5 단위)입니다.
스키마: { \"reading\": { \"summary\": string, \"analysis\": string, \"advice\": string, \"cautions\": string, \"timing\": string, \"score\": number, \"tags\": string[], \"line_readings\": [{\"line\": number, \"meaning\": string}] } }`;

const messages = [
  { role: "system", content: systemPrompt },
  { role: "user", content: `
${taskPrompt}

출력은 위 JSON 스키마를 엄격히 따르세요.
- reading.analysis는 1000~1500자(문단 여러 개)로 象傳/효사 맥락을 풀어주세요.
- reading.score는 0~10점(정수 또는 0.5 단위)로 주세요.
- reading.line_readings는 변효가 없으면 현상 유지 방안을, 있으면 각 효의 핵심 의미를 1~2문장으로 구체화.

질문: ${question ? question : "(없음)"}

JSON 입력:
${JSON.stringify(payload)}
` }
];

    // === OpenAI 호출 (withResponse로 헤더까지 확보) ===
const params = {
  model: OPENAI_MODEL,
  messages,
  max_tokens: OPENAI_MAX_TOKENS,
  response_format: { type: "json_schema", json_schema: schema }
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

    const response = { ok: true, source: "openai", ...payload, reading: parsed.reading };
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
