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
 */

const GRAPH        = 'https://graph.facebook.com/v19.0'
const THREADS_GRAPH = 'https://graph.threads.net/v1.0'
const TIKTOK       = 'https://open.tiktokapis.com/v2'
const GA4          = 'https://analyticsdata.googleapis.com/v1beta'
const ANTHROPIC    = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// ── Agent personas ────────────────────────────────────────────────────────────
const AGENT_PERSONAS = {
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

      return json({ error: 'Not found' }, 404)
    } catch (e) {
      return json({ error: e.message || 'Worker error' }, 500)
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

  const persona = AGENT_PERSONAS[agentId]
  if (!persona) throw new Error(`Unknown agent: ${agentId}`)

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
    blog:      !!(env.NAC_AGENTS),
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
  const pemKey   = env.GA4_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s/g, '')
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
  if (!env.NAC_AGENTS) return { error: 'KV not configured' }

  const numDays = parseInt(url.searchParams.get('days') || '7')
  const idxRaw = await env.NAC_AGENTS.get('blog:days')
  const allDays = idxRaw ? JSON.parse(idxRaw) : []
  const targetDays = allDays.slice(-numDays)

  const dailyData = (await Promise.all(
    targetDays.map(d => env.NAC_AGENTS.get(`blog:daily:${d}`).then(r => r ? { date: d, ...JSON.parse(r) } : null))
  )).filter(Boolean)

  let views = 0, clicks = 0, hovers = 0, bounces = 0, totalTime = 0, scrollSum = 0, scrollCount = 0
  const allSids = new Set()
  const pageAgg = {}
  const refAgg = {}
  const dvArr = []
  const duArr = []
  const recentClicks = []
  const recentHovers = []

  for (const d of dailyData) {
    views += d.v; clicks += d.c; hovers += d.h; bounces += d.b
    totalTime += d.t; scrollSum += d.ss || 0; scrollCount += d.sc || 0
    ;(d.u || []).forEach(s => allSids.add(s))
    dvArr.push(d.v)
    duArr.push((d.u || []).length)

    for (const [p, s] of Object.entries(d.pages || {})) {
      if (!pageAgg[p]) pageAgg[p] = { views: 0, clicks: 0, time: 0, count: 0 }
      pageAgg[p].views += s.v || 0
      pageAgg[p].clicks += s.c || 0
      pageAgg[p].time += s.t || 0
      pageAgg[p].count += s.n || 0
    }
    for (const [r, c] of Object.entries(d.refs || {})) refAgg[r] = (refAgg[r] || 0) + c
    recentClicks.push(...(d.clicks || []))
    recentHovers.push(...(d.hovers || []))
  }

  const topPages = Object.entries(pageAgg)
    .sort((a, b) => b[1].views - a[1].views).slice(0, 10)
    .map(([path, s]) => ({ path, views: s.views, clicks: s.clicks, avgTime: s.count > 0 ? Math.round(s.time / s.count) : 0 }))

  const leaveCount = scrollCount || 1
  return {
    days: numDays, dates: targetDays,
    totalViews: views, uniqueVisitors: allSids.size,
    totalClicks: clicks, totalHovers: hovers,
    bounceRate: views > 0 ? +((bounces / views) * 100).toFixed(1) : 0,
    avgTimeOnPage: Math.round(totalTime / leaveCount),
    avgScrollDepth: Math.round(scrollSum / leaveCount),
    dailyViews: dvArr, dailyVisitors: duArr,
    topPages, referrers: refAgg,
    recentClicks: recentClicks.slice(-30),
    recentHovers: recentHovers.slice(-20),
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
