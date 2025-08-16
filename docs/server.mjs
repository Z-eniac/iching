
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import OpenAI from 'openai'

const PORT = process.env.PORT || 8787
const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

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
          score:     { type: "integer", minimum: 0, maximum: 100 },
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
- 질문 맥락 최우선, 본괘→변괘의 상징 이동과 변효(효사) 중심.
- 단정 대신 실행 가능한 조언.
- 정중한 존댓말.`

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
    const prompt = `사용자 질문과 점괘 JSON이 주어집니다. 아래 스키마에 맞춘 JSON만 출력하세요.
스키마: { "reading": { "summary": string, "advice": string, "cautions": string, "timing": string, "score": number, "tags": string[], "line_readings": [{"line": number, "meaning": string}] } }`

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

app.listen(PORT, () => console.log(`ready on http://localhost:${PORT}`))
