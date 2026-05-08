/**
 * NAC Dashboard — Cloudflare Worker API Proxy
 *
 * Deploy:  wrangler deploy
 * Secrets: wrangler secret put <NAME>   (one per line below)
 *
 * ── Meta (Facebook + Instagram + Threads) ──
 *   FB_PAGE_ACCESS_TOKEN   Long-lived Page Access Token
 *   FB_PAGE_ID             Numeric Page ID
 *   IG_USER_ID             Instagram Business Account ID (numeric)
 *
 * ── TikTok (Display / Creator API v2) ──
 *   TIKTOK_ACCESS_TOKEN    User access token from OAuth flow
 *
 * ── Google Analytics GA4 ──
 *   GA4_PROPERTY_ID        Numeric property ID (no "properties/")
 *   GA4_CLIENT_EMAIL       Service account email
 *   GA4_PRIVATE_KEY        Service account private key (full PEM with \n)
 */

const GRAPH = 'https://graph.facebook.com/v19.0'
const THREADS_GRAPH = 'https://graph.threads.net/v1.0'
const TIKTOK = 'https://open.tiktokapis.com/v2'
const GA4 = 'https://analyticsdata.googleapis.com/v1beta'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function notConfigured(platform) {
  return { _configured: false, _platform: platform }
}

// ─────────────────────────────────────────────────────────
//  ROUTER
// ─────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

    const { pathname } = new URL(request.url)

    const routes = {
      '/api/status':    () => getStatus(env),
      '/api/facebook':  () => getFacebook(env),
      '/api/instagram': () => getInstagram(env),
      '/api/threads':   () => getThreads(env),
      '/api/tiktok':    () => getTikTok(env),
      '/api/analytics': () => getAnalytics(env),
      '/api/all':       () => getAll(env),
    }

    const handler = routes[pathname]
    if (!handler) return json({ error: 'Not found' }, 404)

    try {
      return json(await handler())
    } catch (e) {
      return json({ error: e.message || 'Worker error' }, 500)
    }
  },
}

// ─────────────────────────────────────────────────────────
//  STATUS — which secrets are configured
// ─────────────────────────────────────────────────────────
async function getStatus(env) {
  return {
    facebook:  !!(env.FB_PAGE_ACCESS_TOKEN && env.FB_PAGE_ID),
    instagram: !!(env.FB_PAGE_ACCESS_TOKEN && env.IG_USER_ID),
    threads:   !!(env.FB_PAGE_ACCESS_TOKEN),
    tiktok:    !!(env.TIKTOK_ACCESS_TOKEN),
    analytics: !!(env.GA4_PROPERTY_ID && env.GA4_CLIENT_EMAIL && env.GA4_PRIVATE_KEY),
  }
}

// ─────────────────────────────────────────────────────────
//  ALL — single request for dashboard init
// ─────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────
//  FACEBOOK
// ─────────────────────────────────────────────────────────
async function getFacebook(env) {
  if (!env.FB_PAGE_ACCESS_TOKEN || !env.FB_PAGE_ID) return notConfigured('facebook')

  const tok = env.FB_PAGE_ACCESS_TOKEN
  const pid = env.FB_PAGE_ID

  // Since/until for last 7 days
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

  const dailyReachData = (dailyReachRes.data || []).find(d => d.name === 'page_impressions_unique')
  const dailyReach  = (dailyReachData?.values || []).slice(-7).map(v => v.value)

  return {
    _configured: true,
    followers,
    reach_7d:        reach7d,
    engaged_7d:      engaged7d,
    engagement_rate: followers > 0 ? +((engaged7d / followers) * 100).toFixed(1) : 0,
    daily_reach:     dailyReach,
    page_name:       pageRes.name,
  }
}

// ─────────────────────────────────────────────────────────
//  INSTAGRAM
// ─────────────────────────────────────────────────────────
async function getInstagram(env) {
  if (!env.FB_PAGE_ACCESS_TOKEN || !env.IG_USER_ID) return notConfigured('instagram')

  const tok  = env.FB_PAGE_ACCESS_TOKEN
  const igid = env.IG_USER_ID
  const now   = Math.floor(Date.now() / 1000)
  const since = now - 7 * 86400

  const [profileRes, insightsRes, mediaRes] = await Promise.all([
    gfetch(`${GRAPH}/${igid}?fields=followers_count,media_count,name&access_token=${tok}`),
    gfetch(`${GRAPH}/${igid}/insights?metric=impressions,reach,profile_views&period=day&since=${since}&until=${now}&access_token=${tok}`),
    gfetch(`${GRAPH}/${igid}/media?fields=id,media_type,timestamp,like_count,comments_count&limit=10&access_token=${tok}`),
  ])

  const followers = profileRes.followers_count ?? 0

  const reachData   = (insightsRes.data || []).find(d => d.name === 'reach')
  const impressData = (insightsRes.data || []).find(d => d.name === 'impressions')
  const reach7d     = (reachData?.values || []).reduce((s, v) => s + (v.value || 0), 0)
  const impressions = (impressData?.values || []).reduce((s, v) => s + (v.value || 0), 0)
  const dailyReach  = (reachData?.values || []).slice(-7).map(v => v.value || 0)

  const media        = mediaRes.data || []
  const totalLikes   = media.reduce((s, p) => s + (p.like_count || 0), 0)
  const engagements  = media.reduce((s, p) => s + (p.like_count || 0) + (p.comments_count || 0), 0)
  const engRate      = followers > 0 && media.length > 0
    ? +((engagements / media.length / followers) * 100).toFixed(1) : 0

  return {
    _configured: true,
    followers,
    reach_7d:        reach7d,
    impressions_7d:  impressions,
    engagement_rate: engRate,
    media_count:     profileRes.media_count ?? 0,
    daily_reach:     dailyReach,
    username:        profileRes.name,
  }
}

// ─────────────────────────────────────────────────────────
//  THREADS  (Meta Threads API via graph.threads.net)
// ─────────────────────────────────────────────────────────
async function getThreads(env) {
  if (!env.FB_PAGE_ACCESS_TOKEN) return notConfigured('threads')

  const tok = env.FB_PAGE_ACCESS_TOKEN

  const [profileRes, threadsRes] = await Promise.all([
    gfetch(`${THREADS_GRAPH}/me?fields=id,username,threads_profile_picture_url&access_token=${tok}`),
    gfetch(`${THREADS_GRAPH}/me/threads?fields=id,media_type,text,timestamp,like_count,replies_count,views&limit=20&access_token=${tok}`),
  ])

  const threads     = threadsRes.data || []
  const views7d     = threads.reduce((s, t) => s + (t.views || 0), 0)
  const likes       = threads.reduce((s, t) => s + (t.like_count || 0), 0)
  const replies     = threads.reduce((s, t) => s + (t.replies_count || 0), 0)
  const engRate     = views7d > 0 ? +(((likes + replies) / views7d) * 100).toFixed(1) : 0

  return {
    _configured: true,
    username:        profileRes.username,
    thread_count:    threads.length,
    views_7d:        views7d,
    likes,
    replies,
    engagement_rate: engRate,
    daily_views:     [],
  }
}

// ─────────────────────────────────────────────────────────
//  TIKTOK  (Display API v2)
// ─────────────────────────────────────────────────────────
async function getTikTok(env) {
  if (!env.TIKTOK_ACCESS_TOKEN) return notConfigured('tiktok')

  const tok     = env.TIKTOK_ACCESS_TOKEN
  const fields  = 'id,create_time,share_url,video_description,duration,like_count,comment_count,share_count,view_count,play_count'

  const [userRes, videoRes] = await Promise.all([
    fetch(`${TIKTOK}/user/info/?fields=open_id,union_id,display_name,avatar_url,follower_count,following_count,likes_count,video_count`, {
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

  const views7d  = videos.reduce((s, v) => s + (v.view_count || v.play_count || 0), 0)
  const likes7d  = videos.reduce((s, v) => s + (v.like_count || 0), 0)
  const shares7d = videos.reduce((s, v) => s + (v.share_count || 0), 0)
  const followers = user.follower_count || 0
  const engRate  = views7d > 0 ? +(((likes7d + shares7d) / views7d) * 100).toFixed(1) : 0

  return {
    _configured: true,
    username:        user.display_name,
    followers,
    video_count:     user.video_count || 0,
    views_recent:    views7d,
    likes_recent:    likes7d,
    shares_recent:   shares7d,
    engagement_rate: engRate,
    daily_views:     videos.slice(0, 7).map(v => v.view_count || 0).reverse(),
  }
}

// ─────────────────────────────────────────────────────────
//  GOOGLE ANALYTICS 4
// ─────────────────────────────────────────────────────────
async function getAnalytics(env) {
  if (!env.GA4_PROPERTY_ID || !env.GA4_CLIENT_EMAIL || !env.GA4_PRIVATE_KEY) {
    return notConfigured('analytics')
  }

  const token = await getGA4Token(env)
  const propId = env.GA4_PROPERTY_ID

  const body30 = {
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'activeUsers' },
      { name: 'sessions' },
      { name: 'bounceRate' },
      { name: 'averageSessionDuration' },
    ],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
  }

  const bodyPages = {
    dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'averageSessionDuration' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 10,
  }

  const bodySources = {
    dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  }

  const ga4Post = (endpoint, body) =>
    fetch(`${GA4}/properties/${propId}:${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())

  const [report30, reportPages, reportSources] = await Promise.all([
    ga4Post('runReport', body30),
    ga4Post('runReport', bodyPages),
    ga4Post('runReport', bodySources),
  ])

  const rows30 = report30.rows || []
  const daily_views    = rows30.map(r => parseInt(r.metricValues[0].value) || 0)
  const daily_visitors = rows30.map(r => parseInt(r.metricValues[1].value) || 0)
  const total_views    = daily_views.reduce((a, b) => a + b, 0)
  const total_visitors = daily_visitors.reduce((a, b) => a + b, 0)
  const last_row       = rows30[rows30.length - 1]
  const bounce_rate    = last_row ? parseFloat(last_row.metricValues[3].value) * 100 : 0
  const avg_duration   = last_row ? parseInt(last_row.metricValues[4].value) : 0
  const avg_min        = Math.floor(avg_duration / 60)
  const avg_sec        = avg_duration % 60

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
    page_views_30d:   total_views,
    unique_visitors:  total_visitors,
    avg_session:      `${avg_min}m ${avg_sec.toString().padStart(2, '0')}s`,
    bounce_rate:      +bounce_rate.toFixed(1),
    daily_views,
    daily_visitors,
    top_pages,
    traffic_sources: sources,
  }
}

// ─────────────────────────────────────────────────────────
//  GA4 JWT HELPER
// ─────────────────────────────────────────────────────────
async function getGA4Token(env) {
  const now = Math.floor(Date.now() / 1000)

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim  = b64url(JSON.stringify({
    iss:   env.GA4_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  }))

  const input = `${header}.${claim}`

  const pemKey = env.GA4_PRIVATE_KEY
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')

  const keyBytes = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0))

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(input)
  )

  const jwt = `${input}.${b64urlBytes(new Uint8Array(sigBytes))}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  })

  const { access_token, error } = await res.json()
  if (!access_token) throw new Error(`GA4 token error: ${error}`)
  return access_token
}

// ─────────────────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────────────────
async function gfetch(url) {
  const res = await fetch(url)
  const data = await res.json()
  if (data.error) throw new Error(`Graph API: ${data.error.message}`)
  return data
}

function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlBytes(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
