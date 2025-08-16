
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
        required: ["summary", "advice"],
        properties: {
          summary:   { type: "string" },
          advice:    { type: "string" },
          cautions:  { type: "string" },
          timing:    { type: "string" },
          score:     { type: "number", minimum: 0, maximum: 10 },
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
당신은 주역 64괘 전문 해석가입니다.
출력은 한국어 존댓말을 사용하고, 질문 맥락을 최우선으로 해석합니다.

[해석 절차]
1) 본괘의 큰 판단을 한 줄로 요약합니다(괘사/彖傳 근거).
2) 象傳(상전)의 이미지를 이용해 현재의 정세·분위기를 4~6문장으로 풀이합니다.
   - 필요하면 상괘/하괘(오행·방위·계절) 힌트를 간단히 덧붙입니다.
3) 변효가 있으면 각 변효(효 번호 1~6)를 짧게 해석하고(爻辭 근거),
   마지막에 변괘가 지시하는 방향성으로 통합합니다.
4) 실행 가능한 조언 3~5개를 불릿으로 제시합니다(질문 맥락 연결).
5) 피해야 할 점/주의 2~3개를 불릿으로 제시합니다.
6) 길흉 점수는 0~10점(정수 또는 0.5 단위)로 주고, 한 줄 근거를 덧붙입니다.

[표현 규칙]
- 원전의 짧은 핵심 구절은 「 」로 표시하고, 바로 옆에 한국어 풀이를 붙입니다.
- 단정 대신 실천 지향. 중언부언 금지. 동일 문장 반복 금지.
`

  try {
    const resp = await ai.responses.create({
      model: "gpt-4o",
      input: [
        { role: "system", content: system },
        { role: "user",   content: [
          { type: "text",       text: "다음 JSON을 바탕으로 해석을 생성해 주세요." },
          { type: "input_text", text: JSON.stringify(payload) }
        ] }
      ],
      response_format: { type: "json_schema", json_schema: schema },
      seed: 2025
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
아래 스키마에 맞춘 JSON만 출력하세요.
- 원전(괘사/彖傳/象傳/爻辭)의 짧은 핵심 구절을 「 」로 인용하고 한국어 풀이를 덧붙이세요.
- 길흉 점수는 0~10점(정수 또는 0.5 단위)입니다.

스키마: {
  "reading": {
    "summary": string,
    "advice": string,
    "cautions": string,
    "timing": string,
    "score": number,          // 0~10
    "tags": string[],
    "line_readings": [{"line": number, "meaning": string}]
  }
}`

    const cc = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
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
