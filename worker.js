/**
 * NAC Dashboard — Cloudflare Worker API Proxy
 *
 * Deploy:  wrangler deploy
 * Secrets: wrangler secret put <NAME>
 *
 * ── Meta (Facebook + Instagram + Threads) ──
 *   FB_PAGE_ACCESS_TOKEN   Long-lived Page Access Token
 *   FB_PAGE_ID             Numeric Page ID
 *   IG_USER_ID             Instagram Business Account ID (numeric)
 *
 * ── TikTok ──
 *   TIKTOK_ACCESS_TOKEN    User access token from OAuth flow
 *
 * ── Google Analytics GA4 ──
 *   GA4_PROPERTY_ID        Numeric property ID
 *   GA4_CLIENT_EMAIL       Service account email
 *   GA4_PRIVATE_KEY        Service account private key (full PEM with \n)
 *
 * ── Claude Agent Control ──
 *   ANTHROPIC_API_KEY      Anthropic API key (console.anthropic.com)
 *
 * ── KV Namespace (wrangler.toml) ──
 *   NAC_AGENTS             Stores agent task state + history
 *
 * ── Consulting (client PII, homepage + partner-gateway reachable) ──
 *   NOTION_API_TOKEN       Notion integration token (shared with Lead CRM)
 *   CONSULTING_ACCESS_KEY  Bespoke key required (header X-Consulting-Key) on
 *                          every /api/notion/consultations|questionnaires call
 *                          and /api/consulting-auth — real server-side check,
 *                          not just a UI gate.
 */

const GITHUB_USER  = 'rayvtt'
const GITHUB_API   = 'https://api.github.com'
const GRAPH        = 'https://graph.facebook.com/v19.0'
const THREADS_GRAPH = 'https://graph.threads.net/v1.0'
const TIKTOK       = 'https://open.tiktokapis.com/v2'
const GA4          = 'https://analyticsdata.googleapis.com/v1beta'
const ANTHROPIC    = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'
const NOTION_API   = 'https://api.notion.com/v1'
const NOTION_DB_ID = '2fe48ec2-5e86-80ef-a3a3-fb8113cf6657'
const NOTION_VER   = '2022-06-28'

// ── Consulting process (stage 1: Initial Consultation, stage 2: Questionnaire) ──
// 📞 NAC - Initial Consultations — advisor logs what happened in the first meeting
const NOTION_CONSULT_DB_ID = '14eef0d5-4c2d-4023-8d80-b8b916d9862d'
// 🧾 KYC Intake (Đầu vào khách hàng) — generalized questionnaire, clients submit via Notion form
const NOTION_QUESTIONNAIRE_DB_ID = 'fffac8e9-2444-446d-89b6-f5b6378c8638'
// 🤝 NAC - Partners — access codes + gateway tool grants (joined into the Client Gateway)
const NOTION_PARTNERS_DB_ID = 'a0402cbc-9b57-4ded-ac07-8e087228f19c'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Consulting-Key, x-gateway-token, x-gateway-email',
}

// ── Agent personas ────────────────────────────────────────────────────────────
const AGENT_PERSONAS = {
  leadgen: {
    name: 'Lead Gen Agent',
    emoji: '🎯',
    system: `Bạn là Lead Gen Agent của Nomad Asset Collective (NAC) - thương hiệu bất động sản và lifestyle cao cấp tại Việt Nam.
Nhiệm vụ: tạo outreach messages cá nhân hóa, thuyết phục bằng Tiếng Việt để mời khách hàng tiềm năng tư vấn.

Khi nhận thông tin lead, hãy trả về ĐÚNG định dạng JSON sau (chỉ JSON, không có text khác bên ngoài):
{
  "subject": "Subject line email hấp dẫn, cá nhân hóa",
  "email": "Nội dung email đầy đủ, 150-200 từ",
  "zalo": "Tin nhắn Zalo 60-80 từ, thân thiện, có emoji",
  "whatsapp": "WhatsApp message 60-80 từ, professional",
  "summary": "Tóm tắt 1 câu về profile lead và angle tiếp cận"
}

Quy tắc viết:
- Tiếng Việt chuẩn, chuyên nghiệp nhưng ấm áp, aspirational
- Cá nhân hóa theo role và ngành của lead (đề cập đúng pain point)
- NAC value: bất động sản premium, ROI cao, cộng đồng doanh nhân, lifestyle đẳng cấp
- Email: subject dạng "Tên + pain point + value", body có social proof nhẹ, CTA booking tư vấn
- Zalo: mở đầu bằng tên, emoji phù hợp 2-3 cái, link brochure nếu có
- WhatsApp: trang trọng hơn Zalo, ngắn gọn, link đính kèm
- CTA chính: "đặt lịch tư vấn 1-1 miễn phí" hoặc "xem dự án thực tế"
- Nếu có LinkedIn URL, gợi ý đã xem profile và personalize theo thành tích/kinh nghiệm
- Nếu có brochure URL, đính kèm vào cả 3 kênh
Website: nomadassetcollective.com | Hotline: +84 28 xxxx xxxx`,
  },
  content: {
    name: 'Content Agent',
    emoji: '✍️',
    system: `You are the Content Agent for Nomad Asset Collective (NAC).
You write compelling articles, blog posts, social media captions, and marketing copy.
NAC is a premium real estate and lifestyle brand. Tone: professional, aspirational, clear.
Website: nomadassetcollective.com | Blog: blog.nomadassetcollective.com
When given a task, produce ready-to-publish content. Be concise and impactful.`,
  },
  social: {
    name: 'Social Agent',
    emoji: '📱',
    system: `You are the Social Agent for Nomad Asset Collective (NAC).
You manage and plan social media content across Facebook, Instagram, Threads, and TikTok.
You create post schedules, caption variations, hashtag strategies, and content calendars.
NAC brand voice: premium, aspirational, community-driven. Keep captions punchy and engaging.
When given a task, produce platform-specific ready-to-post content or strategic plans.`,
  },
  data: {
    name: 'Data Agent',
    emoji: '📊',
    system: `You are the Data Agent for Nomad Asset Collective (NAC).
You analyze social media performance, website traffic, engagement metrics, and growth trends.
You produce clear, actionable reports and insights from data provided to you.
Present findings in structured format with key metrics, trends, and recommendations.
Be precise, data-driven, and highlight what actions should be taken based on the numbers.`,
  },
  web: {
    name: 'Web Agent',
    emoji: '🌐',
    system: `You are the Web Agent for Nomad Asset Collective (NAC).
You handle website content, SEO optimization, blog publishing, and site strategy.
Websites: nomadassetcollective.com and blog.nomadassetcollective.com
You write SEO-optimized meta descriptions, titles, headings, and structured content.
When given a task, produce ready-to-implement website copy or SEO recommendations.`,
  },
  research: {
    name: 'Research Agent',
    emoji: '🔍',
    system: `You are the Research Agent for Nomad Asset Collective (NAC).
You research real estate trends, competitor strategies, market data, and industry news.
You identify trending topics, hashtags, content opportunities, and audience insights.
Deliver findings as structured briefs with clear takeaways and actionable next steps.`,
  },
  design: {
    name: 'Design Agent',
    emoji: '🎨',
    system: `You are the Design Agent for Nomad Asset Collective (NAC).
You create briefs for visual content: Instagram carousels, TikTok thumbnails, banner designs.
NAC brand colors: #1800ad (deep blue), #F4622A (orange), white. Premium, modern aesthetic.
You produce detailed design briefs, image prompts for AI tools, and visual content plans.
When given a task, produce a complete brief a designer or AI image tool can execute immediately.`,
  },
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// Consulting data (client PII: names, emails, phone, notes) is reachable from
// the public homepage + partner gateway, so unlike the rest of this worker it
// requires a real server-side key check — a client-side-only gate is not
// security, since anyone can read the fetch URL from devtools.
function requireConsultingKey(request, env) {
  if (!env.CONSULTING_ACCESS_KEY) {
    const e = new Error('CONSULTING_ACCESS_KEY not configured on the worker')
    e.status = 500
    throw e
  }
  const key = request.headers.get('X-Consulting-Key') || ''
  if (key !== env.CONSULTING_ACCESS_KEY) {
    const e = new Error('Invalid or missing consulting access key')
    e.status = 401
    throw e
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

    const url      = new URL(request.url)
    const { pathname } = url

    try {
      // ── Social / Analytics ──
      if (pathname === '/api/status')    return json(await getStatus(env))
      if (pathname === '/api/facebook')  return json(await getFacebook(env))
      if (pathname === '/api/instagram') return json(await getInstagram(env))
      if (pathname === '/api/threads')   return json(await getThreads(env))
      if (pathname === '/api/tiktok')    return json(await getTikTok(env))
      if (pathname === '/api/analytics') return json(await getAnalytics(env))
      if (pathname === '/api/all')       return json(await getAll(env))

      // ── GitHub Repos (Agents) ──
      if (pathname === '/api/github/repos') return json(await getGitHubRepos(env))

      // ── Blog Analytics ──
      if (pathname === '/api/track' && request.method === 'POST') {
        const text = await request.text()
        const event = JSON.parse(text)
        ctx.waitUntil(handleTrack(event, env))
        return json({ ok: true })
      }
      if (pathname === '/api/blog/stats') return json(await getBlogStats(url, env))

      // ── Agent Control ──
      if (pathname === '/api/agents/run'  && request.method === 'POST') return json(await runAgent(request, env))
      if (pathname === '/api/agents/list')                               return json(await listAgents(env))
      if (pathname === '/api/agents/personas')                           return json(getPersonas())
      if (pathname.startsWith('/api/agents/task/') && request.method === 'DELETE') {
        const id = pathname.split('/').pop()
        return json(await deleteTask(id, env))
      }
      if (pathname.startsWith('/api/agents/task/')) {
        const id = pathname.split('/').pop()
        return json(await getTask(id, env))
      }

      // ── Agent Schedules ──
      if (pathname === '/api/agents/schedules' && request.method === 'POST') return json(await createSchedule(request, env))
      if (pathname === '/api/agents/schedules' && request.method === 'GET')  return json(await listSchedules(env))
      if (pathname.startsWith('/api/agents/schedules/') && request.method === 'DELETE') {
        const id = pathname.split('/').pop()
        return json(await deleteSchedule(id, env))
      }

      // ── Lead Gen ──
      if (pathname === '/api/leadgen/generate' && request.method === 'POST') return json(await generateLeadOutreach(request, env))
      if (pathname === '/api/leads/save'       && request.method === 'POST') return json(await saveLead(request, env))
      if (pathname === '/api/leads/list')                                     return json(await listLeads(env))
      if (pathname.startsWith('/api/leads/') && request.method === 'DELETE') {
        const id = pathname.split('/').pop()
        return json(await deleteLead(id, env))
      }

      // ── Notion CRM ──
      if (pathname === '/api/notion/leads'     && request.method === 'POST')  return json(await notionCreateLead(request, env))
      if (pathname === '/api/notion/leads')                                    return json(await notionListLeads(env))
      if (pathname.startsWith('/api/notion/leads/') && request.method === 'PATCH') {
        const pageId = pathname.split('/').pop()
        return json(await notionUpdateLead(pageId, request, env))
      }

      // ── Consulting: access key check (used by the homepage / partner-gateway panels
      //    to verify a key without fetching real data) ──
      if (pathname === '/api/consulting-auth') { requireConsultingKey(request, env); return json({ ok: true }) }

      // ── Consulting: Initial Consultations (stage 1) — all require the access key ──
      if (pathname === '/api/notion/consultations'     && request.method === 'POST') { requireConsultingKey(request, env); return json(await notionCreateConsultation(request, env)) }
      if (pathname === '/api/notion/consultations')                                   { requireConsultingKey(request, env); return json(await notionListConsultations(env)) }
      if (pathname.startsWith('/api/notion/consultations/') && request.method === 'PATCH') {
        requireConsultingKey(request, env)
        const pageId = pathname.split('/').pop()
        return json(await notionUpdateConsultation(pageId, request, env))
      }

      // ── Consulting: Questionnaire / KYC Intake (stage 2) ──
      //    GET  → list submissions · POST → guided intake (creates KYC row + linked consultation)
      //    GET /:id → full single record (for report / follow-up drafting)
      if (pathname === '/api/notion/questionnaires' && request.method === 'POST') { requireConsultingKey(request, env); return json(await notionCreateKyc(request, env)) }
      if (pathname === '/api/notion/questionnaires')                              { requireConsultingKey(request, env); return json(await notionListQuestionnaires(env)) }
      if (pathname.startsWith('/api/notion/questionnaires/')) {
        requireConsultingKey(request, env)
        const pageId = pathname.split('/').pop()
        return json(await notionGetKyc(pageId, env))
      }

      // ── Consulting: KYC field schema (form-render contract, shared by all surfaces) ──
      if (pathname === '/api/consulting/kyc-schema') { requireConsultingKey(request, env); return json({ sections: KYC_SECTIONS }) }

      // ── Consulting: follow-up queue (due / overdue open consultations) ──
      if (pathname === '/api/consulting/followups') { requireConsultingKey(request, env); return json(await consultingFollowups(env)) }

      // ── Consulting: AI draft (bilingual follow-up message OR advisory report) ──
      if (pathname === '/api/consulting/draft' && request.method === 'POST') { requireConsultingKey(request, env); return json(await consultingDraft(request, env)) }

      // ── Client Gateway (blind CRM) — token-gated, assembles clients A→Z ──
      if (pathname === '/api/gateway/clients') {
        const denied = gatewayGuard(request, env)
        if (denied) return denied
        return json(await gatewayClients(env))
      }

      return json({ error: 'Not found' }, 404)
    } catch (e) {
      return json({ error: e.message || 'Worker error' }, e.status || 500)
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
//  AGENT CONTROL
// ─────────────────────────────────────────────────────────────────────────────

function getPersonas() {
  return Object.entries(AGENT_PERSONAS).map(([id, a]) => ({
    id, name: a.name, emoji: a.emoji,
  }))
}

async function runAgent(request, env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')

  const body = await request.json()
  const { agentId, task, context } = body

  if (!agentId || !task) throw new Error('agentId and task are required')

  // Support both legacy personas and repo-based agents
  let persona = AGENT_PERSONAS[agentId]
  if (!persona) {
    // Treat agentId as a repo name — build dynamic persona
    persona = {
      name: agentId,
      emoji: '💻',
      system: `You are an agent working on the "${agentId}" repository for Nomad Asset Collective (NAC).
Repository: github.com/${GITHUB_USER}/${agentId}
NAC is a premium real estate and lifestyle brand. Website: nomadassetcollective.com | Blog: blog.nomadassetcollective.com
Brand colors: #1800ad (deep blue-purple), #F4622A (orange), white.

You assist with code, content, planning, debugging, documentation, and any project tasks for this specific repository.
Be concise, actionable, and produce ready-to-use output.`,
    }
  }

  // Build task ID and initial state
  const taskId  = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const created = new Date().toISOString()

  const taskState = {
    id: taskId,
    agentId,
    agentName: persona.name,
    agentEmoji: persona.emoji,
    task,
    context: context || '',
    status: 'running',
    output: '',
    created,
    updated: created,
  }

  // Persist running state
  if (env.NAC_AGENTS) {
    await env.NAC_AGENTS.put(taskId, JSON.stringify(taskState), { expirationTtl: 86400 * 7 })
  }

  // Call Claude API
  const messages = [{ role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${task}` : task }]

  const claudeRes = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 2048,
      system:     persona.system,
      messages,
    }),
  })

  const claudeData = await claudeRes.json()

  if (!claudeRes.ok) {
    taskState.status = 'error'
    taskState.output = claudeData.error?.message || 'Claude API error'
  } else {
    taskState.status = 'done'
    taskState.output = claudeData.content?.[0]?.text || ''
    taskState.tokens = {
      input:  claudeData.usage?.input_tokens,
      output: claudeData.usage?.output_tokens,
    }
  }

  taskState.updated = new Date().toISOString()

  // Save final state
  if (env.NAC_AGENTS) {
    await env.NAC_AGENTS.put(taskId, JSON.stringify(taskState), { expirationTtl: 86400 * 7 })
    // Update index
    await updateTaskIndex(taskId, env)
  }

  return taskState
}

async function getTask(id, env) {
  if (!env.NAC_AGENTS) return { error: 'KV not configured' }
  const raw = await env.NAC_AGENTS.get(id)
  if (!raw) return { error: 'Task not found' }
  return JSON.parse(raw)
}

async function listAgents(env) {
  if (!env.NAC_AGENTS) return { tasks: [], configured: false }

  const indexRaw = await env.NAC_AGENTS.get('__index__')
  const index    = indexRaw ? JSON.parse(indexRaw) : []

  const tasks = (await Promise.all(
    index.slice(-50).map(id => env.NAC_AGENTS.get(id).then(r => r ? JSON.parse(r) : null))
  )).filter(Boolean).reverse()

  return { tasks, configured: true }
}

async function deleteTask(id, env) {
  if (!env.NAC_AGENTS) return { error: 'KV not configured' }
  await env.NAC_AGENTS.delete(id)
  const indexRaw = await env.NAC_AGENTS.get('__index__')
  const index    = indexRaw ? JSON.parse(indexRaw) : []
  await env.NAC_AGENTS.put('__index__', JSON.stringify(index.filter(i => i !== id)))
  return { deleted: id }
}

async function updateTaskIndex(taskId, env) {
  const indexRaw = await env.NAC_AGENTS.get('__index__')
  const index    = indexRaw ? JSON.parse(indexRaw) : []
  if (!index.includes(taskId)) {
    index.push(taskId)
    await env.NAC_AGENTS.put('__index__', JSON.stringify(index))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LEAD GEN
// ─────────────────────────────────────────────────────────────────────────────

async function generateLeadOutreach(request, env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')

  const body = await request.json()
  const { linkedinUrl, name, title, company, industry, email, phone, brochureUrl, tone, notes } = body

  const persona = AGENT_PERSONAS.leadgen

  const userMsg = `Thông tin lead:
- Tên: ${name || 'Không có'}
- Chức vụ: ${title || 'Không có'}
- Công ty: ${company || 'Không có'}
- Ngành: ${industry || 'Không có'}
- LinkedIn: ${linkedinUrl || 'Không có'}
- Email: ${email || 'Không có'}
- Điện thoại/Zalo: ${phone || 'Không có'}
- Brochure URL: ${brochureUrl || 'Không có'}
- Giọng văn mong muốn: ${tone || 'professional'}
- Ghi chú thêm: ${notes || 'Không có'}

Hãy tạo outreach messages cá nhân hóa cho lead này.`

  const claudeRes = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 2048,
      system:     persona.system,
      messages:   [{ role: 'user', content: userMsg }],
    }),
  })

  const claudeData = await claudeRes.json()
  if (!claudeRes.ok) throw new Error(claudeData.error?.message || 'Claude API error')

  const raw = claudeData.content?.[0]?.text || ''

  let parsed
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    parsed = m ? JSON.parse(m[0]) : null
  } catch { parsed = null }

  if (!parsed) {
    parsed = {
      subject:  'NAC – Cơ hội bất động sản cao cấp dành riêng cho bạn',
      email:    raw,
      zalo:     raw,
      whatsapp: raw,
      summary:  `Lead: ${name || 'Unknown'} – ${title || ''} tại ${company || ''}`,
    }
  }

  return {
    ...parsed,
    leadInfo: { name, title, company, industry, linkedinUrl, email, phone, brochureUrl },
    tokens:   { input: claudeData.usage?.input_tokens, output: claudeData.usage?.output_tokens },
    generated: new Date().toISOString(),
  }
}

async function saveLead(request, env) {
  if (!env.NAC_AGENTS) return { error: 'KV not configured' }
  const lead = await request.json()
  const id   = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const data = { id, ...lead, savedAt: new Date().toISOString() }
  await env.NAC_AGENTS.put(id, JSON.stringify(data), { expirationTtl: 86400 * 180 })
  const idxRaw = await env.NAC_AGENTS.get('__leads_index__')
  const idx    = idxRaw ? JSON.parse(idxRaw) : []
  idx.push(id)
  await env.NAC_AGENTS.put('__leads_index__', JSON.stringify(idx))
  return { saved: true, id }
}

async function listLeads(env) {
  if (!env.NAC_AGENTS) return { leads: [], configured: false }
  const idxRaw = await env.NAC_AGENTS.get('__leads_index__')
  const idx    = idxRaw ? JSON.parse(idxRaw) : []
  const leads  = (await Promise.all(
    idx.slice(-100).map(id => env.NAC_AGENTS.get(id).then(r => r ? JSON.parse(r) : null))
  )).filter(Boolean).reverse()
  return { leads, configured: true }
}

async function deleteLead(id, env) {
  if (!env.NAC_AGENTS) return { error: 'KV not configured' }
  await env.NAC_AGENTS.delete(id)
  const idxRaw = await env.NAC_AGENTS.get('__leads_index__')
  const idx    = idxRaw ? JSON.parse(idxRaw) : []
  await env.NAC_AGENTS.put('__leads_index__', JSON.stringify(idx.filter(i => i !== id)))
  return { deleted: id }
}

// ─────────────────────────────────────────────────────────────────────────────
//  NOTION CRM
// ─────────────────────────────────────────────────────────────────────────────

function notionHeaders(env) {
  return {
    'Authorization': `Bearer ${env.NOTION_API_TOKEN}`,
    'Content-Type':  'application/json',
    'Notion-Version': NOTION_VER,
  }
}

async function notionCreateLead(request, env) {
  if (!env.NOTION_API_TOKEN) throw new Error('NOTION_API_TOKEN not configured')

  const b = await request.json()
  const today = new Date().toISOString().slice(0, 10)

  // Build Ghi chú from company/title/AI content
  let noteText = ''
  if (b.company)    noteText += `Công ty: ${b.company}\n`
  if (b.title)      noteText += `Chức vụ: ${b.title}\n`
  if (b.linkedinUrl) noteText += `LinkedIn: ${b.linkedinUrl}\n`
  if (b.notes)      noteText += `\nGhi chú: ${b.notes}\n`
  if (b.aiSubject)  noteText += `\n[Subject] ${b.aiSubject}\n`
  if (b.aiEmail)    noteText += `\n[Email]\n${b.aiEmail}\n`
  if (b.aiZalo)     noteText += `\n[Zalo]\n${b.aiZalo}\n`
  if (b.aiWhatsapp) noteText += `\n[WhatsApp]\n${b.aiWhatsapp}\n`

  const props = {
    'Tên khách hàng': { title: [{ text: { content: b.name || '' } }] },
    'Ngày liên hệ':   { date:  { start: today } },
    'Status':         { select: { name: b.status || '🆕 Mới' } },
    'Nguồn lead':     { select: { name: b.source || '📧 Email NAC' } },
  }

  if (b.email)    props['Email']           = { email: b.email }
  if (b.phone)    props['Số điện thoại']   = { phone_number: b.phone }
  if (noteText)   props['Ghi chú']         = { rich_text: [{ text: { content: noteText.slice(0, 1999) } }] }
  if (b.budget)   props['Ngân sách (USD)'] = { number: parseFloat(b.budget) || null }
  if (b.timeline) props['Timeline']        = { rich_text: [{ text: { content: b.timeline } }] }

  if (Array.isArray(b.program) && b.program.length) {
    props['Chương trình quan tâm'] = { multi_select: b.program.map(p => ({ name: p })) }
  }
  if (Array.isArray(b.region) && b.region.length) {
    props['Region'] = { multi_select: b.region.map(r => ({ name: r })) }
  }

  const res  = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(env),
    body: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties: props }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || `Notion error: ${res.status}`)
  return { created: true, id: data.id, url: data.url }
}

async function notionListLeads(env) {
  if (!env.NOTION_API_TOKEN) return { leads: [], configured: false }

  const res  = await fetch(`${NOTION_API}/databases/${NOTION_DB_ID}/query`, {
    method: 'POST',
    headers: notionHeaders(env),
    body: JSON.stringify({
      sorts: [{ property: 'Ngày liên hệ', direction: 'descending' }],
      page_size: 100,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || `Notion error: ${res.status}`)

  const leads = (data.results || []).map(page => {
    const p = page.properties
    return {
      id:         page.id,
      notionUrl:  page.url,
      name:       p['Tên khách hàng']?.title?.[0]?.text?.content || '',
      email:      p['Email']?.email || '',
      phone:      p['Số điện thoại']?.phone_number || '',
      status:     p['Status']?.select?.name || '🆕 Mới',
      source:     p['Nguồn lead']?.select?.name || '',
      notes:      p['Ghi chú']?.rich_text?.[0]?.text?.content || '',
      date:       p['Ngày liên hệ']?.date?.start || '',
      budget:     p['Ngân sách (USD)']?.number ?? null,
      timeline:   p['Timeline']?.rich_text?.[0]?.text?.content || '',
      program:    (p['Chương trình quan tâm']?.multi_select || []).map(s => s.name),
      region:     (p['Region']?.multi_select || []).map(s => s.name),
      savedAt:    page.created_time,
    }
  })

  return { leads, configured: true, hasMore: data.has_more }
}

async function notionUpdateLead(pageId, request, env) {
  if (!env.NOTION_API_TOKEN) throw new Error('NOTION_API_TOKEN not configured')

  const b     = await request.json()
  const props = {}

  if (b.status)   props['Status']           = { select: { name: b.status } }
  if (b.notes)    props['Ghi chú']          = { rich_text: [{ text: { content: b.notes.slice(0, 1999) } }] }
  if (b.budget)   props['Ngân sách (USD)']  = { number: parseFloat(b.budget) || null }
  if (b.timeline) props['Timeline']         = { rich_text: [{ text: { content: b.timeline } }] }
  if (Array.isArray(b.program) && b.program.length) {
    props['Chương trình quan tâm'] = { multi_select: b.program.map(p => ({ name: p })) }
  }

  const res  = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(env),
    body: JSON.stringify({ properties: props }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || `Notion error: ${res.status}`)
  return { updated: true, id: pageId }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONSULTING — Initial Consultations (stage 1 of the 4-stage NAC process)
// ─────────────────────────────────────────────────────────────────────────────

async function notionCreateConsultation(request, env) {
  if (!env.NOTION_API_TOKEN) throw new Error('NOTION_API_TOKEN not configured')

  const b     = await request.json()
  const today = new Date().toISOString().slice(0, 10)

  const props = {
    'Client Name':        { title: [{ text: { content: b.name || '' } }] },
    'Consultation Date':  { date:  { start: b.date || today } },
  }

  if (b.email)    props['Client Email']        = { email: b.email }
  if (b.phone)    props['Client Phone']        = { phone_number: b.phone }
  if (b.format)   props['Meeting Format']      = { select: { name: b.format } }
  if (b.notes)    props['Client Goals / Notes'] = { rich_text: [{ text: { content: b.notes.slice(0, 1999) } }] }
  if (b.outcome)  props['Outcome']             = { select: { name: b.outcome } }
  if (b.followUp) props['Follow-up Date']      = { date: { start: b.followUp } }
  if (Array.isArray(b.programs) && b.programs.length) {
    props['Programs Discussed'] = { multi_select: b.programs.map(p => ({ name: p })) }
  }
  if (b.relatedLeadId) {
    props['Related Lead'] = { relation: [{ id: b.relatedLeadId }] }
  }

  const res  = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(env),
    body: JSON.stringify({ parent: { database_id: NOTION_CONSULT_DB_ID }, properties: props }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || `Notion error: ${res.status}`)
  return { created: true, id: data.id, url: data.url }
}

async function notionListConsultations(env) {
  if (!env.NOTION_API_TOKEN) return { consultations: [], configured: false }

  const res  = await fetch(`${NOTION_API}/databases/${NOTION_CONSULT_DB_ID}/query`, {
    method: 'POST',
    headers: notionHeaders(env),
    body: JSON.stringify({
      sorts: [{ property: 'Consultation Date', direction: 'descending' }],
      page_size: 100,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || `Notion error: ${res.status}`)

  const consultations = (data.results || []).map(page => {
    const p = page.properties
    return {
      id:          page.id,
      notionUrl:   page.url,
      name:        p['Client Name']?.title?.[0]?.text?.content || '',
      email:       p['Client Email']?.email || '',
      phone:       p['Client Phone']?.phone_number || '',
      date:        p['Consultation Date']?.date?.start || '',
      format:      p['Meeting Format']?.select?.name || '',
      notes:       p['Client Goals / Notes']?.rich_text?.[0]?.text?.content || '',
      outcome:     p['Outcome']?.select?.name || '',
      followUp:    p['Follow-up Date']?.date?.start || '',
      stage:       p['Stage']?.status?.name || '',
      programs:    (p['Programs Discussed']?.multi_select || []).map(s => s.name),
      advisor:     (p['Advisor']?.people || []).map(u => u.name).join(', '),
      createdTime: page.created_time,
    }
  })

  return { consultations, configured: true, hasMore: data.has_more }
}

async function notionUpdateConsultation(pageId, request, env) {
  if (!env.NOTION_API_TOKEN) throw new Error('NOTION_API_TOKEN not configured')

  const b     = await request.json()
  const props = {}

  if (b.outcome)  props['Outcome']              = { select: { name: b.outcome } }
  if (b.stage)    props['Stage']                = { status: { name: b.stage } }
  if (b.notes)    props['Client Goals / Notes'] = { rich_text: [{ text: { content: b.notes.slice(0, 1999) } }] }
  if (b.followUp) props['Follow-up Date']       = { date: { start: b.followUp } }

  const res  = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(env),
    body: JSON.stringify({ properties: props }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || `Notion error: ${res.status}`)
  return { updated: true, id: pageId }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONSULTING — Questionnaire / KYC Intake (stage 2, read-only)
//  Clients fill this in directly via the Notion form; the dashboard only lists
//  submissions for staff visibility. See NAC-Dashboard CLAUDE.md for the DB.
// ─────────────────────────────────────────────────────────────────────────────

async function notionListQuestionnaires(env) {
  if (!env.NOTION_API_TOKEN) return { questionnaires: [], configured: false }

  const res  = await fetch(`${NOTION_API}/databases/${NOTION_QUESTIONNAIRE_DB_ID}/query`, {
    method: 'POST',
    headers: notionHeaders(env),
    body: JSON.stringify({
      sorts: [{ property: 'Submitted', direction: 'descending' }],
      page_size: 100,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || `Notion error: ${res.status}`)

  const questionnaires = (data.results || []).map(page => {
    const p = page.properties
    return {
      id:          page.id,
      notionUrl:   page.url,
      name:        p['Client name (as per passport)']?.title?.[0]?.text?.content || '',
      nameVi:      p['Họ tên đầy đủ (VI)']?.rich_text?.[0]?.text?.content || '',
      nationality: p['Nationality / Quốc tịch']?.rich_text?.[0]?.text?.content || '',
      submitted:   p['Submitted']?.date?.start || page.created_time?.slice(0, 10) || '',
      stage:       p['Stage']?.status?.name || '',
      programs:    (p['Program / Country']?.multi_select || []).map(s => s.name),
      advisor:     (p['Advisor']?.people || []).map(u => u.name).join(', '),
      budget:      p['Budget range']?.rich_text?.[0]?.text?.content || '',
      createdTime: page.created_time,
    }
  })

  return { questionnaires, configured: true, hasMore: data.has_more }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONSULTING — Guided KYC Intake (stage 2, live-fill walkthrough)
//
//  KYC_SECTIONS is the single source of truth for the form: the worker renders
//  the field contract at /api/consulting/kyc-schema and every surface (dashboard
//  console, homepage / partner-gateway panels) builds the same form from it.
//  `k` = form key · `notion` = Notion property name · `vi`/`en` = bilingual label.
//  All KYC fields are rich_text in Notion except the ones flagged `t:` below.
// ─────────────────────────────────────────────────────────────────────────────

const KYC_PROGRAMS = [
  '🇰🇳 St. Kitts & Nevis', '🇬🇩 Grenada', '🇹🇷 Thổ Nhĩ Kỳ', '🇬🇷 Hy Lạp',
  '🇵🇹 Bồ Đào Nha', '🇨🇾 Síp', '🇭🇺 Hungary', '🇦🇪 Dubai UAE',
  '🇬🇧 Vương quốc Anh', '🇹🇭 Thái Lan', '🇲🇾 Malaysia', '🇲🇹 Malta',
  '🇵🇦 Panama', '🇻🇳 Việt Nam', '🔍 Chưa xác định',
]

const KYC_SECTIONS = [
  { id: 'A', vi: 'Danh tính & liên hệ', en: 'Identity & contact', fields: [
    { k: 'namePassport', notion: 'Client name (as per passport)', t: 'title', vi: 'Họ tên (theo hộ chiếu)', en: 'Name (as per passport)' },
    { k: 'nameVi',       notion: 'Họ tên đầy đủ (VI)',            vi: 'Họ tên đầy đủ (tiếng Việt)', en: 'Full legal name (VI)' },
    { k: 'nameEn',       notion: 'Full legal name (EN)',          vi: 'Họ tên đầy đủ (tiếng Anh)',  en: 'Full legal name (EN)' },
    { k: 'nationality',  notion: 'Nationality / Quốc tịch',       vi: 'Quốc tịch', en: 'Nationality' },
    { k: 'passport',     notion: 'Passport no. & expiry',         vi: 'Số hộ chiếu & ngày hết hạn', en: 'Passport no. & expiry' },
    { k: 'email',        notion: null, consult: 'email',          vi: 'Email', en: 'Email' },
    { k: 'phone',        notion: null, consult: 'phone',          vi: 'Số điện thoại', en: 'Phone' },
    { k: 'marital',      notion: 'Marital status',                vi: 'Tình trạng hôn nhân', en: 'Marital status' },
    { k: 'dependents',   notion: 'Dependents',                    vi: 'Người phụ thuộc', en: 'Dependents' },
  ]},
  { id: 'B', vi: 'Chương trình quan tâm', en: 'Program interest', fields: [
    { k: 'programs',         notion: 'Program / Country', t: 'multi', options: KYC_PROGRAMS, consult: 'programs', vi: 'Chương trình / Quốc gia', en: 'Program / Country' },
    { k: 'objective',        notion: 'Primary objective (growth / yield / residency / hedge)', vi: 'Mục tiêu chính (tăng trưởng / lợi suất / cư trú / phòng vệ)', en: 'Primary objective (growth / yield / residency / hedge)' },
    { k: 'seekingResidency', notion: 'Seeking residency via this program?', vi: 'Có tìm kiếm cư trú qua chương trình này?', en: 'Seeking residency via this program?' },
    { k: 'relocation',       notion: 'Long-term relocation plan', vi: 'Kế hoạch tái định cư dài hạn', en: 'Long-term relocation plan' },
  ]},
  { id: 'C', vi: 'Vốn & nguồn tài sản', en: 'Capital & source of wealth', fields: [
    { k: 'liquidCapital',   notion: 'Liquid capital available',        vi: 'Vốn khả dụng (tiền mặt)', en: 'Liquid capital available' },
    { k: 'netWorth',        notion: 'Estimated net worth range',       vi: 'Ước tính giá trị tài sản ròng', en: 'Estimated net worth range' },
    { k: 'sourceWealth',    notion: 'Primary source of wealth',        vi: 'Nguồn tài sản chính', en: 'Primary source of wealth' },
    { k: 'budget',          notion: 'Budget range',                    vi: 'Khoảng ngân sách', en: 'Budget range' },
    { k: 'financing',       notion: 'Financing or full cash?',         vi: 'Vay tài chính hay toàn tiền mặt?', en: 'Financing or full cash?' },
    { k: 'fundsHeld',       notion: 'Where are funds held (VN / Offshore)', vi: 'Nguồn tiền đang giữ ở đâu (VN / Nước ngoài)', en: 'Where are funds held (VN / Offshore)' },
    { k: 'legalTransfer',   notion: 'Legally transfer funds from Vietnam?', vi: 'Chuyển tiền hợp pháp từ Việt Nam?', en: 'Legally transfer funds from Vietnam?' },
    { k: 'bankStatements',  notion: '6-month bank statements?',         vi: 'Sao kê ngân hàng 6 tháng?', en: '6-month bank statements?' },
    { k: 'offshoreBanking', notion: 'Offshore banking access',         vi: 'Có tài khoản ngân hàng nước ngoài?', en: 'Offshore banking access' },
  ]},
  { id: 'D', vi: 'Ưu tiên đầu tư', en: 'Investment preferences', fields: [
    { k: 'horizon',        notion: 'Investment horizon',          vi: 'Kỳ hạn đầu tư', en: 'Investment horizon' },
    { k: 'risk',           notion: 'Risk tolerance',              vi: 'Khẩu vị rủi ro', en: 'Risk tolerance' },
    { k: 'expectedReturn', notion: 'Expected annual return (%)',  vi: 'Lợi nhuận kỳ vọng/năm (%)', en: 'Expected annual return (%)' },
    { k: 'propertyType',   notion: 'Property type (apartment/villa/commercial)', vi: 'Loại BĐS (căn hộ/biệt thự/thương mại)', en: 'Property type (apartment/villa/commercial)' },
    { k: 'preferredCity',  notion: 'Preferred city/area',         vi: 'Thành phố/khu vực ưu tiên', en: 'Preferred city/area' },
    { k: 'currency',       notion: 'Preferred transaction currency', vi: 'Loại tiền giao dịch ưu tiên', en: 'Preferred transaction currency' },
    { k: 'allocation',     notion: 'Allocation size for this program (%)', vi: 'Quy mô phân bổ cho chương trình (%)', en: 'Allocation size for this program (%)' },
    { k: 'purchaseEntity', notion: 'Purchase under personal or company name?', vi: 'Mua dưới tên cá nhân hay công ty?', en: 'Purchase under personal or company name?' },
    { k: 'rentalMgmt',     notion: 'Rental management required?',  vi: 'Cần quản lý cho thuê?', en: 'Rental management required?' },
  ]},
  { id: 'E', vi: 'Thuế & cư trú', en: 'Tax & residency', fields: [
    { k: 'taxResidence',    notion: 'Country of tax residence',   vi: 'Quốc gia cư trú thuế', en: 'Country of tax residence' },
    { k: 'globalTax',       notion: 'Subject to global income tax?', vi: 'Chịu thuế thu nhập toàn cầu?', en: 'Subject to global income tax?' },
    { k: 'taxAdvisor',      notion: 'Do you have a tax advisor?',  vi: 'Có cố vấn thuế?', en: 'Do you have a tax advisor?' },
    { k: 'taxAware',        notion: 'Aware of home-country tax implications?', vi: 'Hiểu về hệ quả thuế tại quốc gia nhà?', en: 'Aware of home-country tax implications?' },
    { k: 'otherResidencies', notion: 'Other residencies held',    vi: 'Các cư trú khác đang có', en: 'Other residencies held' },
    { k: 'daysPerYear',     notion: 'Days per year in target country', vi: 'Số ngày/năm tại quốc gia đích', en: 'Days per year in target country' },
    { k: 'schooling',       notion: 'Schooling requirement',      vi: 'Nhu cầu về trường học', en: 'Schooling requirement' },
  ]},
  { id: 'F', vi: 'Tuân thủ', en: 'Compliance', fields: [
    { k: 'pep',            notion: 'PEP status',                   vi: 'Trạng thái PEP (nhân vật chính trị)', en: 'PEP status' },
    { k: 'trustStructure', notion: 'Existing holding/trust structure', vi: 'Cấu trúc holding/trust hiện có', en: 'Existing holding/trust structure' },
  ]},
]

// Flatten to a lookup used by the writers/readers.
const KYC_ALL_FIELDS = KYC_SECTIONS.flatMap(s => s.fields)

// Follow-up default: +3 business days from today.
function addBusinessDays(fromIso, n) {
  const d = new Date(fromIso + 'T00:00:00Z')
  let added = 0
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1)
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) added++
  }
  return d.toISOString().slice(0, 10)
}

// Create a KYC Intake row from the guided form, then create a linked Initial
// Consultation record (so profile ↔ meeting ↔ follow-up are joined). Returns both.
async function notionCreateKyc(request, env) {
  if (!env.NOTION_API_TOKEN) throw new Error('NOTION_API_TOKEN not configured')

  const b     = await request.json()
  const today = new Date().toISOString().slice(0, 10)
  const props = {
    'Submitted': { date: { start: b.submitted || today } },
    'Stage':     { status: { name: 'New' } },
  }

  // Map the KYC fields (skip consult-only fields like email/phone → they go on the consultation).
  for (const f of KYC_ALL_FIELDS) {
    if (!f.notion) continue
    const v = b[f.k]
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue
    if (f.t === 'title')      props[f.notion] = { title: [{ text: { content: String(v).slice(0, 1999) } }] }
    else if (f.t === 'multi') props[f.notion] = { multi_select: v.map(x => ({ name: x })) }
    else                      props[f.notion] = { rich_text: [{ text: { content: String(v).slice(0, 1999) } }] }
  }

  const kycRes  = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(env),
    body: JSON.stringify({ parent: { database_id: NOTION_QUESTIONNAIRE_DB_ID }, properties: props }),
  })
  const kyc = await kycRes.json()
  if (!kycRes.ok) throw new Error(kyc.message || `Notion error (KYC): ${kycRes.status}`)

  // Build the linked consultation record.
  const followUp = b.followUp || addBusinessDays(today, 3)
  const cProps = {
    'Client Name':       { title: [{ text: { content: b.namePassport || b.nameEn || b.nameVi || 'Unnamed client' } }] },
    'Consultation Date': { date: { start: b.consultDate || today } },
    'Follow-up Date':    { date: { start: followUp } },
    'Related Questionnaire': { relation: [{ id: kyc.id }] },
  }
  if (b.email)   cProps['Client Email'] = { email: b.email }
  if (b.phone)   cProps['Client Phone'] = { phone_number: b.phone }
  if (b.format)  cProps['Meeting Format'] = { select: { name: b.format } }
  if (b.notes)   cProps['Client Goals / Notes'] = { rich_text: [{ text: { content: String(b.notes).slice(0, 1999) } }] }
  if (Array.isArray(b.programs) && b.programs.length) {
    cProps['Programs Discussed'] = { multi_select: b.programs.map(p => ({ name: p })) }
  }
  if (b.relatedLeadId) cProps['Related Lead'] = { relation: [{ id: b.relatedLeadId }] }

  let consult = null
  const cRes = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(env),
    body: JSON.stringify({ parent: { database_id: NOTION_CONSULT_DB_ID }, properties: cProps }),
  })
  consult = await cRes.json()
  if (!cRes.ok) {
    // KYC saved but consultation failed — surface it, don't lose the intake.
    return { created: true, kycId: kyc.id, kycUrl: kyc.url, consultationError: consult.message || `Notion error (consult): ${cRes.status}`, followUp }
  }

  return { created: true, kycId: kyc.id, kycUrl: kyc.url, consultationId: consult.id, consultationUrl: consult.url, followUp }
}

// Fetch one full KYC record as flat readable {label,value} pairs (for AI drafting + detail view).
async function notionGetKyc(pageId, env) {
  if (!env.NOTION_API_TOKEN) throw new Error('NOTION_API_TOKEN not configured')

  const res  = await fetch(`${NOTION_API}/pages/${pageId}`, { headers: notionHeaders(env) })
  const page = await res.json()
  if (!res.ok) throw new Error(page.message || `Notion error: ${res.status}`)

  const p = page.properties || {}
  const readProp = (prop) => {
    if (!prop) return ''
    if (prop.type === 'title')        return (prop.title || []).map(t => t.plain_text).join('')
    if (prop.type === 'rich_text')    return (prop.rich_text || []).map(t => t.plain_text).join('')
    if (prop.type === 'multi_select') return (prop.multi_select || []).map(s => s.name).join(', ')
    if (prop.type === 'select')       return prop.select?.name || ''
    if (prop.type === 'status')       return prop.status?.name || ''
    if (prop.type === 'date')         return prop.date?.start || ''
    if (prop.type === 'email')        return prop.email || ''
    if (prop.type === 'phone_number') return prop.phone_number || ''
    if (prop.type === 'people')       return (prop.people || []).map(u => u.name).join(', ')
    return ''
  }

  const fields = {}
  for (const [name, prop] of Object.entries(p)) {
    const v = readProp(prop)
    if (v) fields[name] = v
  }
  return { id: page.id, url: page.url, fields }
}

// Due / overdue open consultations (follow-up date ≤ today, not closed).
async function consultingFollowups(env) {
  if (!env.NOTION_API_TOKEN) return { followups: [], configured: false }

  const today = new Date().toISOString().slice(0, 10)
  const res  = await fetch(`${NOTION_API}/databases/${NOTION_CONSULT_DB_ID}/query`, {
    method: 'POST',
    headers: notionHeaders(env),
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Follow-up Date', date: { on_or_before: today } },
          { property: 'Follow-up Date', date: { is_not_empty: true } },
        ],
      },
      sorts: [{ property: 'Follow-up Date', direction: 'ascending' }],
      page_size: 50,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || `Notion error: ${res.status}`)

  const CLOSED = ['Done', 'Won', 'Lost', 'Not a fit', 'Closed']
  const followups = (data.results || []).map(page => {
    const p = page.properties
    return {
      id:        page.id,
      notionUrl: page.url,
      name:      p['Client Name']?.title?.[0]?.plain_text || '',
      email:     p['Client Email']?.email || '',
      phone:     p['Client Phone']?.phone_number || '',
      followUp:  p['Follow-up Date']?.date?.start || '',
      stage:     p['Stage']?.status?.name || '',
      outcome:   p['Outcome']?.select?.name || '',
      programs:  (p['Programs Discussed']?.multi_select || []).map(s => s.name),
      notes:     p['Client Goals / Notes']?.rich_text?.[0]?.plain_text || '',
      overdue:   (p['Follow-up Date']?.date?.start || today) < today,
    }
  }).filter(f => !CLOSED.includes(f.stage) && !CLOSED.includes(f.outcome))

  return { followups, configured: true }
}

// AI draft: bilingual follow-up message OR advisory report, from a client's data.
async function consultingDraft(request, env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')

  const b    = await request.json()
  const kind = b.kind === 'report' ? 'report' : 'followup'
  const rec  = b.record || {}

  // Compact the record into a readable brief.
  const brief = Object.entries(rec).map(([k, v]) => `- ${k}: ${v}`).join('\n')

  const SYSTEMS = {
    followup: `You are a senior advisor at Nomad Asset Collective (NAC), a bilingual Vietnamese/English investment-migration & real-estate advisory. Write a warm, professional follow-up message to a prospective client after their initial consultation. Reference their specific situation. Keep it concise (max ~140 words per language). Output EXACTLY this format with no preamble:\n\n[VI]\n<Vietnamese message>\n\n[EN]\n<English message>`,
    report:   `You are a senior advisor at Nomad Asset Collective (NAC), a bilingual Vietnamese/English investment-migration & real-estate advisory. From the client's KYC intake, write a formal advisory summary: (1) client snapshot, (2) recommended program(s) with rationale tied to their objective/capital/tax situation, (3) key considerations/risks, (4) concrete next steps. Be specific to their data; never invent facts not present. Output EXACTLY this format with no preamble:\n\n[VI]\n<Vietnamese report, use clear headings>\n\n[EN]\n<English report, use clear headings>`,
  }

  const claudeRes = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: kind === 'report' ? 2048 : 1024,
      system:     SYSTEMS[kind],
      messages:   [{ role: 'user', content: `Client data:\n${brief}` }],
    }),
  })
  const data = await claudeRes.json()
  if (!claudeRes.ok) throw new Error(data.error?.message || 'Claude API error')

  const text = data.content?.[0]?.text || ''
  // Split into VI / EN halves for the UI.
  const viMatch = text.match(/\[VI\]([\s\S]*?)(?=\[EN\]|$)/)
  const enMatch = text.match(/\[EN\]([\s\S]*)$/)
  return {
    kind,
    vi: (viMatch?.[1] || '').trim(),
    en: (enMatch?.[1] || text).trim(),
    raw: text,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATUS
// ─────────────────────────────────────────────────────────────────────────────
async function getStatus(env) {
  return {
    facebook:  !!(env.FB_PAGE_ACCESS_TOKEN && env.FB_PAGE_ID),
    instagram: !!(env.FB_PAGE_ACCESS_TOKEN && env.IG_USER_ID),
    threads:   !!(env.FB_PAGE_ACCESS_TOKEN),
    tiktok:    !!(env.TIKTOK_ACCESS_TOKEN),
    analytics: !!(env.GA4_PROPERTY_ID && env.GA4_CLIENT_EMAIL && env.GA4_PRIVATE_KEY),
    agents:    !!(env.ANTHROPIC_API_KEY),
    kv:        !!(env.NAC_AGENTS),
    blog:      !!(env.GA4_PROPERTY_ID && env.GA4_CLIENT_EMAIL && env.GA4_PRIVATE_KEY),
    notion:    !!(env.NOTION_API_TOKEN),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ALL
// ─────────────────────────────────────────────────────────────────────────────
async function getAll(env) {
  const [facebook, instagram, threads, tiktok, analytics] = await Promise.allSettled([
    getFacebook(env),
    getInstagram(env),
    getThreads(env),
    getTikTok(env),
    getAnalytics(env),
  ])
  return {
    facebook:  facebook.status  === 'fulfilled' ? facebook.value  : { error: facebook.reason?.message },
    instagram: instagram.status === 'fulfilled' ? instagram.value : { error: instagram.reason?.message },
    threads:   threads.status   === 'fulfilled' ? threads.value   : { error: threads.reason?.message },
    tiktok:    tiktok.status    === 'fulfilled' ? tiktok.value    : { error: tiktok.reason?.message },
    analytics: analytics.status === 'fulfilled' ? analytics.value : { error: analytics.reason?.message },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FACEBOOK
// ─────────────────────────────────────────────────────────────────────────────
async function getFacebook(env) {
  if (!env.FB_PAGE_ACCESS_TOKEN || !env.FB_PAGE_ID) return { _configured: false, _platform: 'facebook' }
  const tok = env.FB_PAGE_ACCESS_TOKEN
  const pid = env.FB_PAGE_ID
  const now   = Math.floor(Date.now() / 1000)
  const since = now - 7 * 86400
  const [pageRes, insightsRes, dailyReachRes] = await Promise.all([
    gfetch(`${GRAPH}/${pid}?fields=fan_count,followers_count,name&access_token=${tok}`),
    gfetch(`${GRAPH}/${pid}/insights?metric=page_impressions_unique,page_engaged_users,page_post_engagements&period=week&access_token=${tok}`),
    gfetch(`${GRAPH}/${pid}/insights?metric=page_impressions_unique&period=day&since=${since}&until=${now}&access_token=${tok}`),
  ])
  const followers   = pageRes.followers_count ?? pageRes.fan_count ?? 0
  const weekInsight = (insightsRes.data || []).find(d => d.name === 'page_impressions_unique')
  const engInsight  = (insightsRes.data || []).find(d => d.name === 'page_engaged_users')
  const reach7d     = weekInsight?.values?.[0]?.value ?? 0
  const engaged7d   = engInsight?.values?.[0]?.value ?? 0
  const dailyData   = (dailyReachRes.data || []).find(d => d.name === 'page_impressions_unique')
  const dailyReach  = (dailyData?.values || []).slice(-7).map(v => v.value)
  return {
    _configured: true, followers, reach_7d: reach7d, engaged_7d: engaged7d,
    engagement_rate: followers > 0 ? +((engaged7d / followers) * 100).toFixed(1) : 0,
    daily_reach: dailyReach, page_name: pageRes.name,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  INSTAGRAM
// ─────────────────────────────────────────────────────────────────────────────
async function getInstagram(env) {
  if (!env.FB_PAGE_ACCESS_TOKEN || !env.IG_USER_ID) return { _configured: false, _platform: 'instagram' }
  const tok  = env.FB_PAGE_ACCESS_TOKEN
  const igid = env.IG_USER_ID
  const now   = Math.floor(Date.now() / 1000)
  const since = now - 7 * 86400
  const [profileRes, insightsRes, mediaRes] = await Promise.all([
    gfetch(`${GRAPH}/${igid}?fields=followers_count,media_count,name&access_token=${tok}`),
    gfetch(`${GRAPH}/${igid}/insights?metric=impressions,reach,profile_views&period=day&since=${since}&until=${now}&access_token=${tok}`),
    gfetch(`${GRAPH}/${igid}/media?fields=id,media_type,timestamp,like_count,comments_count&limit=10&access_token=${tok}`),
  ])
  const followers   = profileRes.followers_count ?? 0
  const reachData   = (insightsRes.data || []).find(d => d.name === 'reach')
  const impressData = (insightsRes.data || []).find(d => d.name === 'impressions')
  const reach7d     = (reachData?.values || []).reduce((s, v) => s + (v.value || 0), 0)
  const impressions = (impressData?.values || []).reduce((s, v) => s + (v.value || 0), 0)
  const dailyReach  = (reachData?.values || []).slice(-7).map(v => v.value || 0)
  const media       = mediaRes.data || []
  const engagements = media.reduce((s, p) => s + (p.like_count || 0) + (p.comments_count || 0), 0)
  const engRate     = followers > 0 && media.length > 0 ? +((engagements / media.length / followers) * 100).toFixed(1) : 0
  return {
    _configured: true, followers, reach_7d: reach7d, impressions_7d: impressions,
    engagement_rate: engRate, media_count: profileRes.media_count ?? 0,
    daily_reach: dailyReach, username: profileRes.name,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  THREADS
// ─────────────────────────────────────────────────────────────────────────────
async function getThreads(env) {
  if (!env.FB_PAGE_ACCESS_TOKEN) return { _configured: false, _platform: 'threads' }
  const tok = env.FB_PAGE_ACCESS_TOKEN
  const [profileRes, threadsRes] = await Promise.all([
    gfetch(`${THREADS_GRAPH}/me?fields=id,username&access_token=${tok}`),
    gfetch(`${THREADS_GRAPH}/me/threads?fields=id,media_type,text,timestamp,like_count,replies_count,views&limit=20&access_token=${tok}`),
  ])
  const threads = threadsRes.data || []
  const views7d = threads.reduce((s, t) => s + (t.views || 0), 0)
  const likes   = threads.reduce((s, t) => s + (t.like_count || 0), 0)
  const replies = threads.reduce((s, t) => s + (t.replies_count || 0), 0)
  return {
    _configured: true, username: profileRes.username, thread_count: threads.length,
    views_7d: views7d, likes, replies,
    engagement_rate: views7d > 0 ? +(((likes + replies) / views7d) * 100).toFixed(1) : 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIKTOK
// ─────────────────────────────────────────────────────────────────────────────
async function getTikTok(env) {
  if (!env.TIKTOK_ACCESS_TOKEN) return { _configured: false, _platform: 'tiktok' }
  const tok    = env.TIKTOK_ACCESS_TOKEN
  const fields = 'id,create_time,like_count,comment_count,share_count,view_count,play_count'
  const [userRes, videoRes] = await Promise.all([
    fetch(`${TIKTOK}/user/info/?fields=open_id,display_name,follower_count,video_count`, {
      headers: { Authorization: `Bearer ${tok}` },
    }).then(r => r.json()),
    fetch(`${TIKTOK}/video/list/?fields=${encodeURIComponent(fields)}&max_count=20`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_count: 20 }),
    }).then(r => r.json()),
  ])
  const user   = userRes?.data?.user || {}
  const videos = videoRes?.data?.videos || []
  const views  = videos.reduce((s, v) => s + (v.view_count || v.play_count || 0), 0)
  const likes  = videos.reduce((s, v) => s + (v.like_count || 0), 0)
  const shares = videos.reduce((s, v) => s + (v.share_count || 0), 0)
  return {
    _configured: true, username: user.display_name, followers: user.follower_count || 0,
    video_count: user.video_count || 0, views_recent: views, likes_recent: likes, shares_recent: shares,
    engagement_rate: views > 0 ? +(((likes + shares) / views) * 100).toFixed(1) : 0,
    daily_views: videos.slice(0, 7).map(v => v.view_count || 0).reverse(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GOOGLE ANALYTICS 4
// ─────────────────────────────────────────────────────────────────────────────
async function getAnalytics(env) {
  if (!env.GA4_PROPERTY_ID || !env.GA4_CLIENT_EMAIL || !env.GA4_PRIVATE_KEY) {
    return { _configured: false, _platform: 'analytics' }
  }
  const token  = await getGA4Token(env)
  const propId = env.GA4_PROPERTY_ID
  const ga4Post = (endpoint, body) =>
    fetch(`${GA4}/properties/${propId}:${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())

  const [report30, reportPages, reportSources] = await Promise.all([
    ga4Post('runReport', {
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
    ga4Post('runReport', {
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'averageSessionDuration' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 10,
    }),
    ga4Post('runReport', {
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),
  ])

  const rows30         = report30.rows || []
  const daily_views    = rows30.map(r => parseInt(r.metricValues[0].value) || 0)
  const daily_visitors = rows30.map(r => parseInt(r.metricValues[1].value) || 0)
  const last           = rows30[rows30.length - 1]
  const bounce_rate    = last ? parseFloat(last.metricValues[2].value) * 100 : 0
  const avg_duration   = last ? parseInt(last.metricValues[3].value) : 0

  const top_pages = (reportPages.rows || []).slice(0, 5).map(r => ({
    path: r.dimensionValues[0].value,
    views: parseInt(r.metricValues[0].value) || 0,
    avg_duration: parseInt(r.metricValues[1].value) || 0,
  }))

  const sources = {}
  ;(reportSources.rows || []).forEach(r => {
    sources[r.dimensionValues[0].value] = parseInt(r.metricValues[0].value) || 0
  })

  return {
    _configured: true,
    page_views_30d:  daily_views.reduce((a, b) => a + b, 0),
    unique_visitors: daily_visitors.reduce((a, b) => a + b, 0),
    avg_session:     `${Math.floor(avg_duration / 60)}m ${(avg_duration % 60).toString().padStart(2, '0')}s`,
    bounce_rate:     +bounce_rate.toFixed(1),
    daily_views, daily_visitors, top_pages, traffic_sources: sources,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GA4 JWT
// ─────────────────────────────────────────────────────────────────────────────
async function getGA4Token(env) {
  const now    = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim  = b64url(JSON.stringify({
    iss: env.GA4_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  }))
  const input    = `${header}.${claim}`
  const pemKey   = env.GA4_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\\n/g, '').replace(/\s/g, '')
  const keyBytes = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0))
  const privateKey = await crypto.subtle.importKey('pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sigBytes   = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input))
  const jwt        = `${input}.${b64urlBytes(new Uint8Array(sigBytes))}`
  const res        = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  })
  const { access_token, error } = await res.json()
  if (!access_token) throw new Error(`GA4 token error: ${error}`)
  return access_token
}

// ─────────────────────────────────────────────────────────────────────────────
//  GITHUB REPOS → AGENTS
// ─────────────────────────────────────────────────────────────────────────────
async function getGitHubRepos(env) {
  // Check KV cache first (5 min TTL)
  if (env.NAC_AGENTS) {
    const cached = await env.NAC_AGENTS.get('__github_repos__')
    if (cached) return JSON.parse(cached)
  }

  const res = await fetch(`${GITHUB_API}/users/${GITHUB_USER}/repos?sort=updated&per_page=30`, {
    headers: { 'User-Agent': 'NAC-Dashboard/1.0', Accept: 'application/vnd.github.v3+json' },
  })
  if (!res.ok) throw new Error(`GitHub API: ${res.status}`)
  const raw = await res.json()

  const repos = raw.map(r => ({
    id:          r.name,
    name:        r.name,
    description: r.description || '',
    language:    r.language || '',
    updated:     r.updated_at,
    url:         r.html_url,
    stars:       r.stargazers_count,
    open_issues: r.open_issues_count,
  }))

  const result = { repos, fetched: new Date().toISOString() }

  // Cache for 5 minutes
  if (env.NAC_AGENTS) {
    await env.NAC_AGENTS.put('__github_repos__', JSON.stringify(result), { expirationTtl: 300 })
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
//  AGENT SCHEDULES
// ─────────────────────────────────────────────────────────────────────────────
async function createSchedule(request, env) {
  if (!env.NAC_AGENTS) return { error: 'KV not configured' }
  const body = await request.json()
  const { agentId, task, context, freq, day } = body
  if (!agentId || !task) throw new Error('agentId and task are required')

  const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const schedule = { id, agentId, task, context: context || '', freq, day, created: new Date().toISOString(), lastRun: null }

  await env.NAC_AGENTS.put(id, JSON.stringify(schedule), { expirationTtl: 86400 * 365 })

  const idxRaw = await env.NAC_AGENTS.get('__schedules_index__')
  const idx = idxRaw ? JSON.parse(idxRaw) : []
  idx.push(id)
  await env.NAC_AGENTS.put('__schedules_index__', JSON.stringify(idx))

  return { saved: true, id }
}

async function listSchedules(env) {
  if (!env.NAC_AGENTS) return { schedules: [], configured: false }
  const idxRaw = await env.NAC_AGENTS.get('__schedules_index__')
  const idx = idxRaw ? JSON.parse(idxRaw) : []
  const schedules = (await Promise.all(
    idx.map(id => env.NAC_AGENTS.get(id).then(r => r ? JSON.parse(r) : null))
  )).filter(Boolean)
  return { schedules, configured: true }
}

async function deleteSchedule(id, env) {
  if (!env.NAC_AGENTS) return { error: 'KV not configured' }
  await env.NAC_AGENTS.delete(id)
  const idxRaw = await env.NAC_AGENTS.get('__schedules_index__')
  const idx = idxRaw ? JSON.parse(idxRaw) : []
  await env.NAC_AGENTS.put('__schedules_index__', JSON.stringify(idx.filter(i => i !== id)))
  return { deleted: id }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BLOG ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────
async function handleTrack(event, env) {
  if (!env.NAC_AGENTS) return

  const today = new Date().toISOString().slice(0, 10)
  const key = `blog:daily:${today}`
  const raw = await env.NAC_AGENTS.get(key)
  const day = raw ? JSON.parse(raw) : {
    v: 0, u: [], c: 0, h: 0, b: 0, t: 0, ss: 0, sc: 0,
    pages: {}, refs: {}, clicks: [], hovers: []
  }

  const sid = event.sid || 'anon'
  const pg = event.page || '/'

  switch (event.type) {
    case 'pageview':
      day.v++
      if (!day.u.includes(sid) && day.u.length < 500) day.u.push(sid)
      if (!day.pages[pg]) day.pages[pg] = { v: 0, c: 0, t: 0, n: 0 }
      day.pages[pg].v++
      if (event.referrer) {
        try {
          const ref = new URL(event.referrer).hostname || 'direct'
          day.refs[ref] = (day.refs[ref] || 0) + 1
        } catch { day.refs['direct'] = (day.refs['direct'] || 0) + 1 }
      } else {
        day.refs['direct'] = (day.refs['direct'] || 0) + 1
      }
      break
    case 'click':
      day.c++
      if (day.clicks.length < 200)
        day.clicks.push({ p: pg, t: (event.text || '').slice(0, 50), h: event.href || '' })
      if (day.pages[pg]) day.pages[pg].c++
      break
    case 'hover':
      day.h++
      if (day.hovers.length < 100)
        day.hovers.push({ p: pg, t: (event.text || '').slice(0, 50) })
      break
    case 'leave':
      if (event.bounce) day.b++
      if (event.timeOnPage) {
        day.t += event.timeOnPage
        if (day.pages[pg]) { day.pages[pg].t += event.timeOnPage; day.pages[pg].n++ }
      }
      if (event.scrollDepth) { day.ss += event.scrollDepth; day.sc++ }
      break
  }

  await env.NAC_AGENTS.put(key, JSON.stringify(day), { expirationTtl: 86400 * 90 })

  const idxRaw = await env.NAC_AGENTS.get('blog:days')
  const days = idxRaw ? JSON.parse(idxRaw) : []
  if (!days.includes(today)) {
    days.push(today)
    while (days.length > 90) days.shift()
    await env.NAC_AGENTS.put('blog:days', JSON.stringify(days))
  }
}

async function getBlogStats(url, env) {
  if (!env.GA4_PROPERTY_ID || !env.GA4_CLIENT_EMAIL || !env.GA4_PRIVATE_KEY) {
    return { error: 'GA4 not configured' }
  }

  const numDays = parseInt(url.searchParams.get('days') || '30')
  const token   = await getGA4Token(env)
  const propId  = env.GA4_PROPERTY_ID

  const ga4Post = (body) =>
    fetch(`${GA4}/properties/${propId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())

  const blogFilter = {
    filter: { fieldName: 'hostName', stringFilter: { value: 'blog.nomadassetcollective.com' } }
  }

  const [dailyReport, pagesReport, sourcesReport, clicksReport] = await Promise.all([
    // Daily views + visitors + bounce + duration
    ga4Post({
      dateRanges: [{ startDate: `${numDays}daysAgo`, endDate: 'today' }],
      dimensionFilter: blogFilter,
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'activeUsers' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
    // Top pages
    ga4Post({
      dateRanges: [{ startDate: `${numDays}daysAgo`, endDate: 'today' }],
      dimensionFilter: blogFilter,
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'averageSessionDuration' },
        { name: 'activeUsers' },
      ],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 10,
    }),
    // Traffic sources
    ga4Post({
      dateRanges: [{ startDate: `${numDays}daysAgo`, endDate: 'today' }],
      dimensionFilter: blogFilter,
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),
    // Click events (GA4 enhanced measurement)
    ga4Post({
      dateRanges: [{ startDate: `${numDays}daysAgo`, endDate: 'today' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'hostName', stringFilter: { value: 'blog.nomadassetcollective.com' } } },
            { filter: { fieldName: 'eventName', stringFilter: { value: 'click' } } },
          ]
        }
      },
      dimensions: [{ name: 'pagePath' }, { name: 'linkUrl' }],
      metrics: [{ name: 'eventCount' }],
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 30,
    }),
  ])

  // Parse daily data
  const dailyRows = dailyReport.rows || []
  const dates = dailyRows.map(r => {
    const d = r.dimensionValues[0].value
    return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`
  })
  const dailyViews    = dailyRows.map(r => parseInt(r.metricValues[0].value) || 0)
  const dailyVisitors = dailyRows.map(r => parseInt(r.metricValues[1].value) || 0)

  const totalViews    = dailyViews.reduce((a, b) => a + b, 0)
  const uniqueVisitors = dailyVisitors.reduce((a, b) => a + b, 0)

  const lastRow      = dailyRows[dailyRows.length - 1]
  const bounceRate   = lastRow ? +(parseFloat(lastRow.metricValues[2].value) * 100).toFixed(1) : 0
  const avgDuration  = lastRow ? parseInt(lastRow.metricValues[3].value) : 0

  // Parse top pages
  const topPages = (pagesReport.rows || []).slice(0, 10).map(r => ({
    path:    r.dimensionValues[0].value,
    views:   parseInt(r.metricValues[0].value) || 0,
    clicks:  0,
    avgTime: parseInt(r.metricValues[1].value) || 0,
  }))

  // Parse traffic sources
  const referrers = {}
  ;(sourcesReport.rows || []).forEach(r => {
    referrers[r.dimensionValues[0].value] = parseInt(r.metricValues[0].value) || 0
  })

  // Parse click events
  const totalClicks = (clicksReport.rows || []).reduce((s, r) => s + (parseInt(r.metricValues[0].value) || 0), 0)
  const recentClicks = (clicksReport.rows || []).slice(0, 15).map(r => ({
    p: r.dimensionValues[0].value,
    t: (r.dimensionValues[1]?.value || '').slice(0, 60),
  }))

  return {
    days: numDays, dates,
    totalViews, uniqueVisitors,
    totalClicks, totalHovers: 0,
    bounceRate,
    avgTimeOnPage: avgDuration,
    avgScrollDepth: 0,
    dailyViews, dailyVisitors,
    topPages, referrers,
    recentClicks,
    recentHovers: [],
    source: 'ga4',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────────────────────────────────────
async function gfetch(url) {
  const res  = await fetch(url)
  const data = await res.json()
  if (data.error) throw new Error(`Graph API: ${data.error.message}`)
  return data
}
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlBytes(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLIENT GATEWAY — blind CRM (token-gated), assembles clients A→Z from Notion
//  Front-end: client-gateway.html. Real data is served ONLY past this guard.
// ─────────────────────────────────────────────────────────────────────────────
const GW_STAGES = 12 // mirrors the 12-step journey spine in client-gateway.html

// Verify the access token (and optional email allowlist) server-side.
// Returns a Response on failure, or null when authorized.
function gatewayGuard(request, env) {
  if (!env.GATEWAY_TOKEN) {
    return json({ error: 'Gateway not configured — set GATEWAY_TOKEN on the worker.' }, 503)
  }
  const token = request.headers.get('x-gateway-token') || ''
  const email = (request.headers.get('x-gateway-email') || '').trim().toLowerCase()
  if (token !== env.GATEWAY_TOKEN) return json({ error: 'unauthorized' }, 401)
  if (env.GATEWAY_EMAILS) {
    const allow = env.GATEWAY_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    if (allow.length && !allow.includes(email)) return json({ error: 'unauthorized' }, 401)
  }
  return null
}

const gwNorm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const GW_PROGRAM_FLAG = {
  'malta':'🇲🇹 Malta','dao sip':'🇨🇾 Cyprus','sip':'🇨🇾 Cyprus','cyprus':'🇨🇾 Cyprus',
  'hy lap':'🇬🇷 Greece','greece':'🇬🇷 Greece','bo dao nha':'🇵🇹 Portugal','portugal':'🇵🇹 Portugal',
  'tho nhi ky':'🇹🇷 Turkey','turkey':'🇹🇷 Turkey','uae':'🇦🇪 UAE','dubai':'🇦🇪 UAE',
  'anh':'🇬🇧 UK','uk':'🇬🇧 UK','thai lan':'🇹🇭 Thailand','thailand':'🇹🇭 Thailand',
  'malaysia':'🇲🇾 Malaysia','panama':'🇵🇦 Panama','kitts':'🇰🇳 St Kitts','grenada':'🇬🇩 Grenada',
  'new zealand':'🇳🇿 New Zealand','australia':'🇦🇺 Australia','nauru':'🇳🇷 Nauru','hungary':'🇭🇺 Hungary',
}
function gwProgramFlag(name) {
  const n = gwNorm(name)
  for (const k in GW_PROGRAM_FLAG) { if (n.includes(k)) return GW_PROGRAM_FLAG[k] }
  return name
}

// Vietnamese Lead-CRM status → gateway status pill + appetite + stage index
function gwStageFromStatus(status) {
  switch (status) {
    case '🆕 Mới':
    case 'Mới':               return { status: ['New', 'info'],    appetite: ['TBD', 'muted'], stage: 0 }
    case '📞 Đã liên hệ':      return { status: ['Active', 'good'], appetite: ['Warm', 'warn'], stage: 1 }
    case '🔥 Tiềm năng':       return { status: ['Hot', 'warn'],    appetite: ['High', 'good'], stage: 3 }
    case '✅ Chốt được':       return { status: ['Won', 'good'],    appetite: ['High', 'good'], stage: 6 }
    case '❌ Không quan tâm':   return { status: ['Closed', 'muted'],appetite: ['Low', 'muted'], stage: 0 }
    default:                  return { status: [status || '—', 'muted'], appetite: ['TBD', 'muted'], stage: 0 }
  }
}

function gwSteps(stage) {
  const notes = ['Consultation logged.', 'KYC / questionnaire.', 'Program shortlist.', 'Property selection.', 'Source of funds.', 'Reservation deposit.', 'Agreement & financing.', 'Government application.', 'Approval in principle.', 'Completion.', 'Residency / passport.', 'Handover & aftercare.']
  const out = []
  for (let i = 0; i < GW_STAGES; i++) out.push([i < stage ? 'done' : i === stage ? 'now' : 'todo', '—', i <= stage ? notes[i] : ''])
  return out
}

async function notionListPartners(env) {
  if (!env.NOTION_API_TOKEN) return []
  try {
    const res = await fetch(`${NOTION_API}/databases/${NOTION_PARTNERS_DB_ID}/query`, {
      method: 'POST', headers: notionHeaders(env), body: JSON.stringify({ page_size: 100 }),
    })
    const data = await res.json()
    if (!res.ok) return []
    return (data.results || []).map(pg => {
      const p = pg.properties
      return {
        name:       p['Partner']?.title?.[0]?.plain_text || '',
        contact:    p['Contact Name']?.rich_text?.[0]?.plain_text || '',
        code:       p['Access Code']?.rich_text?.[0]?.plain_text || '',
        opens:      p['Access Opens']?.number || 0,
        lastAccess: p['Last Access']?.date?.start || '',
        added:      (pg.created_time || '').slice(0, 10),
        material:   (p['Material Sent']?.multi_select || []).map(m => m.name),
      }
    })
  } catch (_) { return [] }
}

function gwToolsFromPartner(partner) {
  const tools = []
  if (partner?.code) tools.push(['🏠', 'Property Hub', 'Live listings — yield/IRR/payback', ['Granted', 'brand'], partner.opens ? `Opened ${partner.opens}×` : 'Code issued — awaiting first open'])
  const mat = partner?.material || []
  if (mat.includes('📘 Country Brochure')) tools.push(['📘', 'Country Brochure', 'Program brief', ['Shared', 'info'], 'Link sent'])
  if (mat.includes('🏠 Listing PDP'))      tools.push(['🏠', 'Listing PDP', 'Property detail', ['Shared', 'info'], 'Link sent'])
  if (mat.includes('📊 Pitch Deck'))       tools.push(['📊', 'Pitch Deck', 'Overview deck', ['Shared', 'info'], 'Link sent'])
  if (mat.includes('📈 Case Study'))       tools.push(['📈', 'Case Study', 'Worked example', ['Shared', 'info'], 'Link sent'])
  if (!tools.length) tools.push(['🧰', 'No tools granted yet', '—', ['Pending', 'muted'], 'Issue an access code to begin'])
  return tools
}

function mapLeadToClient(lead, partner, i) {
  const meta  = gwStageFromStatus(lead.status)
  const flags = (lead.program || []).map(gwProgramFlag)
  const code  = partner?.code || ''
  const touch = []
  if (lead.date) touch.push([lead.date, 'Consult', 'Lead logged / contacted.', 0])
  if (code)      touch.push([partner.added || lead.date || '—', 'Access', `Access code ${code} issued.`, 1])
  return {
    id: lead.id, real: true, av: i % 5,
    name: lead.name || 'Unnamed',
    email: lead.email || null, phone: lead.phone || null,
    location: (lead.region || [])[0] || '—',
    advisor: 'Ray Vũ', source: lead.source || '—',
    status: meta.status, appetite: meta.appetite,
    budget: lead.budget || null, cur: 'USD',
    code: code || null,
    codeIssued: partner?.added || '—',
    codeOpens: partner?.opens || 0,
    lastAccess: partner?.lastAccess || (code ? 'Not yet opened' : '—'),
    programs: flags,
    stage: meta.stage, progress: Math.round(meta.stage / GW_STAGES * 100),
    notion: lead.notionUrl || null,
    consult: {
      date: lead.date || '—', format: '—', dur: '',
      outcome: meta.stage > 0 ? ['Proceeding', 'good'] : null,
      summary: lead.notes || 'No consultation summary logged yet.',
      goals: [], concerns: [],
    },
    property: { status: flags.length ? ['Shortlisting', 'warn'] : ['—', 'muted'], locked: null, options: flags.slice(), note: lead.timeline || '' },
    deal: null,
    tools: gwToolsFromPartner(partner),
    touch: touch.length ? touch : [['—', '—', 'No touchpoints logged.', 0]],
    docs: [],
    steps: gwSteps(meta.stage),
    next: { body: lead.timeline || 'Follow up with the client.', due: '—', owner: 'Ray Vũ' },
  }
}

async function gatewayClients(env) {
  const [leadsRes, partners] = await Promise.all([notionListLeads(env), notionListPartners(env)])
  if (!leadsRes.configured) return { clients: [], configured: false, error: 'NOTION_API_TOKEN not configured on the worker.' }
  const byName = new Map()
  for (const p of partners) {
    if (p.contact) byName.set(gwNorm(p.contact), p)
    if (p.name)    byName.set(gwNorm(p.name), p)
  }
  const clients = (leadsRes.leads || []).map((lead, i) => mapLeadToClient(lead, byName.get(gwNorm(lead.name)), i))
  return { clients, configured: true, count: clients.length }
}
