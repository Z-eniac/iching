// server.mjs — Render/Node용 안정화 버전
// - /api/read, /api/ai 둘 다 지원
// - 예산 가드(미설정 시 무제한), 연타 방지, 간단 캐시, 일일 사용량 카운터(UTC 자정 리셋)
// - USE_OPENAI=false 로 테스트 모드(과금/호출 차단)
// - /api/usage?key=ADMIN_KEY 로 남은 토큰/호출 확인(개인용)

import express from "express";
import cors from "cors";
import OpenAI from "openai";

// ============= 기본 서버 설정 =============
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Health check (Render에서 사용)
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// 루트 확인용 (정적 사이트가 따로 있으면 이 경로는 써도 됨)
app.get("/", (_, res) => res.status(200).send("OK"));

// ============= ENV & 안전장치 =============
const AI_ON = String(process.env.USE_OPENAI ?? "true") === "true"; // 기본 on, Render에서 false로 테스트
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // /api/usage 보호키

// 예산(USD) — 미설정/잘못된 값이면 무제한
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD) || Infinity;

// 단가(1M tokens 기준) — gpt-4o-mini
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

// 간단 메모리 캐시 (3일)
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
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // baseURL: process.env.OPENAI_BASE_URL || undefined, // 필요 시 프록시 설정
});

// ============= 유틸 =============
function truncate(str = "", max = 1600) {
  return str.length > max ? str.slice(0, max) + " …(trimmed)" : str;
}
function costUSD(inTok = 0, outTok = 0) {
  const perTokIn = PRICE_IN_PER_M / 1_000_000;  // $/token
  const perTokOut = PRICE_OUT_PER_M / 1_000_000; // $/token
  return +(inTok * perTokIn + outTok * perTokOut);
}

// 시스템 프롬프트
const systemPrompt = `
당신은 주역 64괘 전문 해석가입니다. 원전에 충실한 해석을 한국어 존댓말로 답하십시오.

[편향 교정] (매우 중요)
- 일반론적 자기계발 어휘(꾸준함·루틴·마인드셋·동기부여·생산성·자기관리) 사용 금지.
- 위로성 완곡 표현 금지. 불리할 땐 명확히 ‘불리/흉’로 판정.

[점수 루브릭]
- 대길: 9–10 (근거에 「元亨」「利涉大川」 등 길문이 뚜렷)
- 길: 7–8.5
- 소길: 6–6.5
- 미지/중립: 4.5–5.5
- 소흉: 3–4.5
- 흉: 1–2.5 (「凶」「吝」「悔」 우세, 변효 3개↑가 불리 방향)
- 대흉: 0–1 (중대한 금기·재앙 암시)
[해석 절차]
1) 본괘와 변괘의 판단을 한 줄로 요약합니다(괘사/彖傳 근거).
2) 象傳의 이미지로 현재 정세를 6~10문장(최소 600자)으로 풀이합니다.
   - 내괘(본괘 및 변괘의 1-3효로 구성된 팔괘)와 외괘(본괘 및 변괘의 4-6효로 구성된 팔괘)의 오행·방위·계절 힌트를 간단히 포함.
3) 변효가 있으면 각 변효(1~6효)를 짧게 해석하고(爻辭 근거 병기), 마지막에 변괘 방향성으로 통합합니다.
4) 조언 3~5개(Bullet)와 주의할 점 2~3개(Bullet)를 제시합니다.
5) 길흉 점수는 0~10점(정수 또는 0.5 단위)로, 한 줄 근거를 덧붙입니다.

[표현 규칙]
- 점술가의 해석답게 실천적이고 일반적인 덕담보다는 신비롭게 해석할 것.
- 원전의 핵심 구절은 「 」로 인용하고 바로 한국어 풀이를 붙입니다.
- 중언부언/문장 반복 금지, 실행지향. 전체 분량은 600~1000자.
- 상괘, 하괘를 각각 본괘, 변괘와 혼용하지 말고 "본괘"와 "변괘"로 통일.
- 모든 해석·조언은 철저하게 점괘가 말하는 것을 위주로 작성할 것.
- 위로/무난한 결론 금지: 나쁠 땐 분명히 나쁘다고 말하기. “그럼에도” 화법 남발 금지.
- 길흉점수 규칙(0~10, 0.5 단위):
  대길 9–10, 길 7–8.5, 소길 6–6.5, 미지 5±0.5, 소흉 3–4.5, 흉 1–2.5, 대흉 0–1.
  ‘凶/吝/悔’·불리 문구가 우세하면 5 이하로 내릴 것. 극단값(0~1, 9~10)도 허용.
- 조언 3~5개는 전부 효사/象傳에 앵커: “무엇을/언제/어떻게” + (근거: …)
- 타이밍은 팔괘 계절·방위로 표시. (예: 내괘 坎→겨울·북 / 외괘 震→봄·동)

`;

// Structured Outputs 스키마
const schema = {
  name: "iching_reading",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reading: {
        type: "object",
        additionalProperties: true,
        properties: {
          analysis: { type: "string" },
          score: { type: "number" },
          line_readings: { type: "array", items: { type: "string" } }
        },
        required: ["analysis", "score", "line_readings"]
      }
    },
    required: ["reading"]
  }
};

// ============= 조회용(개인) =============
app.get("/api/usage", (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  rollDay();
  res.json({ ok: true, day: dayUsage.day, limits: { tokens: 200_000, requests: 200 }, used: { tokens: dayUsage.tokens, requests: dayUsage.calls, usd: +dayUsage.spent.toFixed(6) }, remaining: { tokens: Math.max(0, 200_000 - dayUsage.tokens), requests: Math.max(0, 200 - dayUsage.calls) }, reset_hint: "매일 KST 09:00 (UTC 00:00)" });
});

// ============= 핵심 라우트 =============
app.post(["/api/read", "/api/ai"], async (req, res) => {
  console.log("[HIT] /api/read", new Date().toISOString());

  // 테스트 모드(과금/호출 차단)
  if (!AI_ON) {
    console.warn("[STUB MODE] USE_OPENAI=false");
    return res.json({ ok: true, source: "stub", reading: { analysis: "테스트 모드: OpenAI 호출 없이 기본 흐름만 확인합니다.", score: 5, line_readings: ["기본 응답입니다."] } });
  }

  if (inflight) {
    console.warn("[BLOCK] inflight");
    return res.status(429).json({ ok: false, error: "이미 처리 중입니다." });
  }
  inflight = true;

  // 요청 파싱
  const { question = "", method = "coin", primary = {}, relating = {}, changingLines = [] } = req.body || {};
  const payload = { question, method, primary, relating, changingLines };
  console.log("[REQ]", JSON.stringify(payload));

  // 캐시 체크
  const key = cacheKeyOf(payload);
  const hit = getCache(key);
  if (hit) {
    console.log("[CACHE HIT]", key);
    inflight = false; // 캐시 리턴 시에도 해제
    return res.json({ ok: true, source: "cache", ...hit });
  }

  // 일일 예산 확인
  rollDay();
  if (dayUsage.spent >= DAILY_BUDGET_USD) {
    inflight = false;
    console.warn("[BUDGET BLOCK]", { spent: dayUsage.spent, budget: DAILY_BUDGET_USD });
    return res.status(429).json({ ok: false, error: "일일 AI 예산 한도 초과" });
  }

  // 유저 프롬프트 구성(길이 제한)
  const userContent = truncate(
    (question ? `질문: ${question}\n` : "") +
    `출력은 아래 JSON 스키마를 엄격히 따르세요.
    - reading.analysis는 600~1000자(문단 여러 개)로 象傳/효사 맥락을 풀어주세요.
    - reading.score는 0-10점(정수 또는 0.5 단위)로 주세요.
    - reading.line_readings는 각 변효의 핵심을 1~2문장으로.
    
    JSON 입력:
    ` + JSON.stringify(payload)
  );

  let parsed; // try 바깥에 선언
  try {
    const cc = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.8,
      top_p: 0.9,
      presence_penalty: 0.2,
      frequency_penalty: 0.2,
      n: 1,
      max_tokens: 1200,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ]
    });

    console.log("[OPENAI BASE]", process.env.OPENAI_BASE_URL || "(default: api.openai.com)");
    console.log("[RESP ID]", cc?.id);

    const u = cc?.usage || {};
    const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
    const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
    const totalTok = inTok + outTok;

    // 일일 카운터/예산 누적
    dayUsage.tokens += totalTok;
    dayUsage.calls += 1;
    const $$ = costUSD(inTok, outTok);
    dayUsage.spent += $$;

    console.log("=== USAGE ===", u);
    console.log("[RUN COST] this_call=$", $$.toFixed(6), "spent_today=$", dayUsage.spent.toFixed(6));

    // Structured Outputs 파싱 (SDK가 parsed를 제공할 수 있음)
    parsed = cc.choices?.[0]?.message?.parsed;
    if (!parsed) {
      const msg = cc.choices?.[0]?.message?.content ?? "{}";
      const s = msg.indexOf("{"); const e = msg.lastIndexOf("}");
      parsed = s >= 0 ? JSON.parse(msg.slice(s, e + 1)) : {};
    }

    if (!parsed?.reading) throw new Error("chat.completions: invalid JSON");

    console.log("[OK chat.completions structured]");
    const response = { ok: true, source: "openai", ...payload, reading: parsed.reading };
    setCache(key, response);
    return res.json(response);
  } catch (e) {
    console.warn("[WARN chat.completions]", e?.response?.status, e?.response?.data || e?.message);
    return res.status(500).json({ error: "ai_read_failed", message: "AI 해석을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.", hint: "키 권한, 결제/한도, 서버 로그를 확인해 주세요." });
  } finally {
    inflight = false; // 성공/실패/예외 모두 해제
  }
});

// ============= 서버 시작 =============
const port = process.env.PORT || 8787;
app.listen(port, "0.0.0.0", () => console.log("listening", port));
