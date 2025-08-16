
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

// (4) 서버 시작
app.listen(PORT, () => console.log(`ready on http://localhost:${PORT}`))

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

app.get('/health', (req,res)=> res.json({ ok:true, port: PORT }))
app.post('/echo', (req,res)=> res.json({ ok:true, body: req.body }))

app.post('/api/read', async (req, res) => {
  const { question = "", method = "coin", primary = {}, relating = {}, changingLines = [] } = req.body || {}
  const payload = { question, method, primary, relating, changingLines }
  console.log('[REQ]', JSON.stringify(payload))

const system = `
당신은 주역 64괘 전문 해석가입니다. 한국어 존댓말로 답하십시오.

[해석 절차]
1) 본괘와 변괘의 판단을 한 줄로 요약합니다(괘사/彖傳 근거).
2) 象傳의 이미지로 현재 정세를 6~10문장(최소 600자)으로 풀이합니다.
   - 상괘/하괘의 오행·방위·계절 힌트를 간단히 포함.
3) 변효가 있으면 각 변효(1~6효)를 짧게 해석하고(爻辭 근거), 마지막에 변괘 방향성으로 통합합니다.
4) 실행 가능한 조언 3~5개(불릿)와 주의 2~3개(불릿)를 제시합니다.
5) 길흉 점수는 0~10점(정수 또는 0.5 단위)로, 한 줄 근거를 덧붙입니다.

[표현 규칙]
- 원전의 핵심 구절은 「 」로 인용하고 바로 한국어 풀이를 붙입니다.
- 중언부언/문장 반복 금지, 실행지향. 전체 분량은 600~1000자.
`

  try {
    const resp = await ai.responses.create({
      model: "gpt-4o",
      instructions: system,
      input: [
        { role: "user",   content: [
          { type: "input_text", text: "다음 JSON을 바탕으로 해석을 생성해 주세요." },
          { type: "input_text", text: JSON.stringify(payload) }
        ] }
      ],
      text: {
      format: "json_schema",
      // 기존에 선언해 둔 schema 객체( name, schema, strict 포함 )
      schema
      },
        max_output_tokens: 1000,        // ← 충분히 길게
        temperature: 0.6,
    })
    const parsed = resp.output_parsed
      ?? (resp.output_text ? JSON.parse(resp.output_text) : null)
      ?? (resp.output?.[0]?.content?.[0]?.type === 'output_text'
            ? JSON.parse(resp.output[0].content[0].text)
            : null)
    if (parsed?.reading) {
      console.log('[OK responses.create]')
      return res.json({ ...payload, reading: parsed.reading })
    }
    throw new Error('responses.create: no parsed.reading')
  } catch (e) {
    console.warn('[WARN responses.create]', e?.response?.status, e?.response?.data || e?.message)
  }

  try {
    const prompt = `사용자 질문과 점괘 JSON이 주어집니다.
- analysis에 600~1000자 분량의 象傳 기반 본문을 쓰세요.
- 길흉 점수는 0~10점(정수/0.5 단위)입니다.
스키마: { "reading": { "summary": string, "analysis": string,
"advice": string, "cautions": string, "timing": string,
"score": number, "tags": string[], "line_readings": [{"line": number, "meaning": string}] } }`

const cc = await ai.chat.completions.create({
  model: "gpt-4o-mini",
  temperature: 0.6,
  max_tokens: 1000,                      // chat.completions는 max_tokens
  seed: 2025,
  messages: [
    { role: "system", content: system },
    { role: "user", content: prompt + "\n\nJSON:\n" + JSON.stringify(payload) }
  ]
})
    
    const msg = cc.choices?.[0]?.message?.content || "{}"
    const jsonStart = msg.indexOf("{")
    const jsonEnd   = msg.lastIndexOf("}")
    const slice = jsonStart >= 0 ? msg.slice(jsonStart, jsonEnd + 1) : "{}"
    const parsed = JSON.parse(slice)
    if (parsed?.reading) {
      console.log('[OK chat.completions fallback]')
      return res.json({ ...payload, reading: parsed.reading })
    }
    throw new Error('chat.completions: invalid JSON')
  } catch (e) {
    console.warn('[WARN chat.completions]', e?.response?.status, e?.response?.data || e?.message)
  }

  return res.status(500).json({
    error: 'ai_read_failed',
    message: 'AI 해석을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
    hint: '키 권한(All), 결제/한도, 서버 로그를 확인해 주세요.'
  })
})
