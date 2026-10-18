import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const DAILY_LIMIT = 5, GLOBAL_LIMIT = 30 // question-making calls per parent per day (protects your API bill)
const reply = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
    const { data: u } = await admin.auth.getUser(token)
    if (!u?.user) return reply({ error: 'login required' }, 401)

    const today = new Date().toISOString().slice(0, 10)
    const { count } = await admin.from('usage').select('id', { count: 'exact', head: true })
      .eq('user_id', u.user.id).eq('day', today)
    if ((count ?? 0) >= DAILY_LIMIT) return reply({ error: 'daily limit reached', items: [] })
    const { count: all } = await admin.from('usage').select('id', { count: 'exact', head: true }).eq('day', today)
    if ((all ?? 0) >= GLOBAL_LIMIT) return reply({ error: 'daily free limit reached, try tomorrow', items: [] })
    await admin.from('usage').insert({ user_id: u.user.id })

    const b = await req.json()
    const prompt =
      'You write quiz questions for a curious ' + (b.age || 9) + '-year-old (CBSE Grade ' + (b.grade || 3) +
      ', lives in Abu Dhabi, Indian family). Create 8 multiple-choice questions, randomly mixing: Hindu epics and mythology, ' +
      'Indian history (Shivaji Maharaj and the Marathas, Mughals, British era, freedom struggle), other religions (informative, neutral), ' +
      'world geography and geopolitics, economics and finance, AI and technology, health and medicine, space and science, sports, nature, ' +
      'the UAE, logic riddles, English words and grammar, Arabic words, simple Hindi words. ' +
      'Include 4 questions on recent world events (use web search if available; only facts you can confirm; neutral, non-graphic, never taking sides). ' +
      (b.news ? 'The parent says this is in the news: ' + JSON.stringify(b.news) + '. Make 4 questions from it. ' : '') +
      (b.chapters ? 'School topics this month: ' + b.chapters + '. Include 3 questions on these. ' : '') +
      (b.weak?.length ? 'Make these topics easier: ' + b.weak.join(', ') + '. ' : '') +
      (b.strong?.length ? 'Make these topics harder: ' + b.strong.join(', ') + '. ' : '') +
      'Simple fun wording, answers under 6 words, plausible wrong options, exactly one correct answer, double-check every answer. ' +
      'Do not repeat: ' + (b.recent || []).join(' | ') + '. ' +
      'Return ONLY a JSON array of objects: {"q":"","c":"correct answer","w":["wrong1","wrong2","wrong3"],"e":"one fun sentence explaining","cat":"emoji and topic, e.g. \ud83c\udf10 World"}'

    // OpenRouter: discover which free models exist right now, then try a few in order.
    const KEY = Deno.env.get('OPENROUTER_API_KEY')!
    let free: string[] = []
    try {
      const lm = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: 'Bearer ' + KEY } })
      if (lm.ok) {
        const jm = await lm.json()
        const good = /llama|gemma|qwen|mistral|deepseek|gpt-oss|nemotron|glm/i
        free = (jm.data || [])
          .filter((m: any) => String(m.id).endsWith(':free') && !/(vision|image|audio|embed|guard|safety|tts|whisper|moderation|vl)/i.test(m.id))
          .sort((a: any, b: any) => (Number(good.test(b.id)) - Number(good.test(a.id))) || ((b.context_length || 0) - (a.context_length || 0)))
          .map((m: any) => String(m.id))
      }
    } catch (_) { /* use the fixed fallback below */ }
    const MODELS = [...new Set([Deno.env.get('OPENROUTER_MODEL'), ...free.slice(0, 6), 'meta-llama/llama-3.3-70b-instruct:free'].filter(Boolean) as string[])].slice(0, 4)
    const errs: string[] = []
    let firstBody = ''
    const ask = async (model: string) => {
      const ac = new AbortController()
      const to = setTimeout(() => ac.abort(), 18000)
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', signal: ac.signal,
          headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://arunsangle.github.io/brain-quest/', 'X-Title': 'Brain Quest' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 2500 }),
        })
        if (!r.ok) { const t = await r.text(); if (!firstBody) firstBody = t.replace(/\s+/g, ' ').slice(0, 110); throw new Error(model.split('/').pop()!.slice(0, 22) + ' ' + r.status) }
        const j = await r.json()
        const t = j.choices?.[0]?.message?.content || ''
        return JSON.parse(t.slice(t.indexOf('[{'), t.lastIndexOf('}]') + 2))
      } finally { clearTimeout(to) }
    }
    let arr: any[] | null = null
    for (const m of MODELS) {
      try { arr = await ask(m); break } catch (e) { errs.push(String(e).replace('Error: ', '').slice(0, 40)); console.error('failed:', String(e)) }
    }
    if (!arr) throw new Error('listed ' + free.length + ' free models. tried ' + errs.join(', ') + '. first: ' + firstBody)
    const rows = arr.filter((o: any) => o.q && o.c && Array.isArray(o.w) && o.w.length >= 3 && o.e)
      .map((o: any) => ({ q: o.q, c: o.c, w: o.w.slice(0, 3), e: o.e, cat: o.cat || null, grade: b.grade || 3 }))
    if (!rows.length) return reply({ error: 'no valid questions returned by the model', items: [] })
    if (rows.length) await admin.from('questions').upsert(rows, { onConflict: 'q', ignoreDuplicates: true })
    return reply({ items: rows })
  } catch (e) {
    console.error('make-questions failed:', String(e))
    return reply({ error: String(e).slice(0, 330), items: [] }, 200)
  }
})
