
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import OpenAI from 'openai'

const PORT = process.env.PORT || 8787
const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

//    server.mjs와 같은 폴더의 /public 디렉터리를 정적으로 노출
app.use(express.static('public'))  // public/index.html, public/**.* 접근 가능

// 헬스체크 라우트 추가
app.get("/", (req, res) => {
  res.status(200).send("OK");
});
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// (4) 서버 시작
app.listen(PORT, "0.0.0.0", () => console.log(`ready on http://localhost:${PORT}`))

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const schema = {
  name: "IChingReading",
  schema: {
    type: "object",
    required: ["reading"],
    properties: {
      reading: {
        type: "object",
        required: ["summary", "analysis", "advice", "cautions", "timing", "score", "line_readings"],
        properties: {
          summary:   { type: "string" },
          analysis:  { type: "string" },                     // 길고 풍부한 본문
          advice:    { type: "string" },
          cautions:  { type: "string" },
          timing:    { type: "string" },
          score:     { type: "number", minimum: 0, maximum: 10 }, // 10점제
          tags:      { type: "array", items: { type: "string" } },
          line_readings: {
            type: "array",
            items: {
              type: "object",
              required: ["line", "meaning"],
              properties: {
                line: { type: "integer", minimum: 1, maximum: 6 },
                meaning: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
}

app.post('/echo', (req,res)=> res.json({ ok:true, body: req.body }))

app.post('/api/read', async (req, res) => {
  const { question = "", method = "coin", primary = {}, relating = {}, changingLines = [] } = req.body || {}
  const payload = { question, method, primary, relating, changingLines }
  console.log('[REQ]', JSON.stringify(payload))

const system = `
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
`

  try {
    const prompt = `사용자 질문과 점괘 JSON이 주어집니다.
- 질문(question) 문자열 맨 앞에 [오더: ...] 블록이 있을 수 있음. 있으면 그 지시(금지어/점수분포/톤 등)를 **최우선**으로 반영하세요.
- analysis에 600~1000자 분량의 象傳 기반 본문을 쓰세요.
- 길흉 점수는 0~10점(정수/0.5 단위)입니다.
스키마: { "reading": { "summary": string, "analysis": string,
"advice": string, "cautions": string, "timing": string,
"score": number, "tags": string[], "line_readings": [{"line": number, "meaning": string}] } }`

 const cc = await ai.chat.completions.create({
   model: "gpt-4o-mini",
   temperature: 0.8,
   top_p: 0.9,
   presence_penalty: 0.2,
   frequency_penalty: 0.2,
   n: 1,                // 두 안 생성 후 클라이언트에서 더 날 것 선택
   max_tokens: 1200,
   // ✅ Structured Outputs(스키마 강제)
   response_format: {
     type: "json_schema",
     json_schema: schema   // 위에서 선언해둔 const schema 그대로 사용
   },
   messages: [
     { role: "system", content: system },
     { role: "user", content:
       // 프롬프트를 조금 강화(길이/스코어/변효 안내)
       prompt +
       "\n\n출력은 위 JSON 스키마를 엄격히 따르세요." +
       "\n- reading.analysis는 600~1000자(문단 여러 개)로 象傳/효사 맥락을 풀어주세요." +
       "\n- reading.score는 0~10점(정수 또는 0.5 단위)로 주세요." +
       "\n- reading.line_readings는 변효가 없으면 현상 유지 방안을, 있으면 각 효의 핵심 의미를 1~2문장으로 구체화." +
       "\n\nJSON:\n" + JSON.stringify(payload)
     }
   ]
 })
    
    console.log("=== USAGE ===", cc.usage);

const BAN = /(루틴|꾸준|마인드셋|자기관리|생산성|동기부여|정리하세요|계획하세요|습관화)/g;
const genericScore = (txt) => (txt.match(BAN)||[]).length;
    
 // SDK 버전에 따라 message.parsed가 올 수도, content가 JSON 문자열로 올 수도 있음
 let parsed = cc.choices?.[0]?.message?.parsed
 if (!parsed) {
   const msg = cc.choices?.[0]?.message?.content ?? "{}"
   const start = msg.indexOf("{")
   const end   = msg.lastIndexOf("}")
   const slice = start >= 0 ? msg.slice(start, end + 1) : "{}"
   parsed = JSON.parse(slice)
 }
 if (parsed?.reading) {
   console.log('[OK chat.completions structured]')
   return res.json({ ...payload, reading: parsed.reading })
 }
 throw new Error('chat.completions: invalid JSON')
  } catch (e) {
    console.warn('[WARN chat.completions]', e?.response?.status, e?.response?.data || e?.message)
  }

  if (parsed?.reading) {
  const g = genericScore(
    parsed.reading.analysis + parsed.reading.advice + parsed.reading.cautions
  );
  const scoreTooSafe = parsed.reading.score && parsed.reading.score >= 6 && /凶|吝|悔/.test(parsed.reading.analysis);
  if (g > 0 || scoreTooSafe) {
    // 두 번째 패스: “일반론 제거+루브릭 재적용” 지시
    const redo = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [
        { role:"system", content: system + "\n이전 출력은 상투어/점수편향이 있어 재작성합니다." },
        { role:"user", content:
          "다음 초안을 상투어 제거, 루브릭에 따라 점수 재산정, 모든 조언에 근거 표기하여 다시 써라.\n" +
          JSON.stringify({ question, method, primary, relating, changingLines })
        }
      ]
    });
    // redo.parsed 읽어서 대체
  }
}

  return res.status(500).json({
    error: 'ai_read_failed',
    message: 'AI 해석을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
    hint: '키 권한(All), 결제/한도, 서버 로그를 확인해 주세요.'
  })
})
