import { Hono } from 'hono'
import { sign, verify } from 'hono/jwt'
import { getStorage } from './db'

const app = new Hono()
const JWT_SECRET = process.env.JWT_SECRET || 'bili-vault-default-secret-change-me'

// ==========================================
// Auth helpers
// ==========================================
function getToken(c: any) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

async function authGuard(c: any, next: any) {
  const token = getToken(c)
  if (!token) return c.json({ success: false, error: '未登录' }, 401)
  try {
    const payload = await verify(token, JWT_SECRET, 'HS256')
    c.set('userId', payload.userId)
    c.set('username', payload.username)
    await next()
  } catch {
    return c.json({ success: false, error: '登录已过期' }, 401)
  }
}

// ==========================================
// Public: image proxy
// ==========================================
app.get('/api/proxy/image', async (c) => {
  const url = c.req.query('url')
  if (!url) return c.body(null, 400)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.bilibili.com/' } })
    return c.body(await res.arrayBuffer(), 200, { 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'max-age=86400' })
  } catch { return c.body(null, 404) }
})

// ==========================================
// Public: videoshot proxy (fallback cover)
// ==========================================
app.get('/api/proxy/videoshot', async (c) => {
  const bvid = c.req.query('bvid')
  if (!bvid) return c.body(null, 400)
  try {
    const res = await fetch(`https://api.bilibili.com/x/player/videoshot?bvid=${bvid}&index=1`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com/',
      },
    })
    const data: any = await res.json()
    if (data.code !== 0 || !data.data?.image?.length) return c.body(null, 404)
    const imgUrl = data.data.image[0]
    const absUrl = imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl
    const img = await fetch(absUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    return c.body(await img.arrayBuffer(), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'max-age=86400',
    })
  } catch { return c.body(null, 404) }
})

// ==========================================
// Public: storage info
// ==========================================
app.get('/api/storage/info', async (c) => {
  const storage = await getStorage(c.env)
  return c.json({ type: storage.type, webdavUrl: process.env.WEBDAV_URL || null })
})

// ==========================================
// Public: auth (register / login)
// ==========================================
app.post('/api/auth/register', async (c) => {
  const { username, passwordHash } = await c.req.json()
  if (!username || !passwordHash) return c.json({ success: false, error: '缺少参数' }, 400)
  const storage = await getStorage(c.env)
  const id = crypto.randomUUID()
  const result = await storage.createUser(id, username, passwordHash)
  if (!result.success) return c.json(result, 400)
  const token = await sign({ userId: id, username, exp: Math.floor(Date.now() / 1000) + 86400 * 30 }, JWT_SECRET)
  return c.json({ success: true, token, userId: id, username })
})

app.post('/api/auth/login', async (c) => {
  const { username, passwordHash } = await c.req.json()
  if (!username || !passwordHash) return c.json({ success: false, error: '缺少参数' }, 400)
  const storage = await getStorage(c.env)
  const user = await storage.getUserByUsername(username)
  if (!user || user.password_hash !== passwordHash) return c.json({ success: false, error: '用户名或密码错误' }, 401)
  const token = await sign({ userId: user.id, username, exp: Math.floor(Date.now() / 1000) + 86400 * 30 }, JWT_SECRET)
  return c.json({ success: true, token, userId: user.id, username })
})

app.post('/api/auth/verify', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ success: false }, 401)
  try {
    const payload = await verify(token, JWT_SECRET, 'HS256')
    return c.json({ success: true, userId: payload.userId, username: payload.username })
  } catch { return c.json({ success: false }, 401) }
})

// ==========================================
// Protected: user config
// ==========================================
app.post('/api/user/config', authGuard, async (c) => {
  const userId = c.get('userId')
  const { biliCookie, encryptCookie, isAutoSync, encryptEnabled, fullEncrypt, noBase64, fetchLimit, fetchMaxPages, autoFetchInterval, encryptAlgo, publicKeyPem, encryptedPrivateKey, privateKeyIv } = await c.req.json()
  const storage = await getStorage(c.env)
  await storage.saveUserConfig(userId, { biliCookie, encryptCookie, isAutoSync, encryptEnabled, fullEncrypt, noBase64, fetchLimit, fetchMaxPages, autoFetchInterval, encryptAlgo, publicKeyPem, encryptedPrivateKey, privateKeyIv })
  return c.json({ success: true })
})

app.get('/api/user/config', authGuard, async (c) => {
  const userId = c.get('userId')
  const storage = await getStorage(c.env)
  const config = await storage.getUserConfig(userId)
  return c.json({ success: true, config })
})

// ==========================================
// Helper: build B站 Cookie header
// ==========================================
function buildBiliCookie(input: string) {
  // If input is a raw SESSDATA value (no cookie format), wrap it
  if (!input.includes('=')) return `SESSDATA=${input}`
  // Preserve original cookies, inject buvid3 if missing
  let out = input.trim()
  if (!out.includes('buvid3=')) {
    out += `; buvid3=infoc_${Date.now()}${Math.random().toString(36).slice(2, 10)}`
  }
  return out
}

// ==========================================
// Protected: bilibili fetch
// ==========================================
app.post('/api/bili/fetch', authGuard, async (c) => {
  const { cookie, limit: totalLimit } = await c.req.json()
  if (!cookie) return c.json({ success: false, error: '缺少 Cookie' }, 400)
  const userId = c.get('userId')
  const storage = await getStorage(c.env)
  const ps = 30 // B站每页最大，减少请求次数

  try {
    const allItems: any[] = []
    let max = 0
    let viewAt = 0
    let emptyPage = 0
    while (true) {
      const url = `https://api.bilibili.com/x/web-interface/history/cursor?ps=${ps}${max ? `&max=${max}&view_at=${viewAt}` : ''}`
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': buildBiliCookie(cookie),
          'Referer': 'https://www.bilibili.com/',
        },
      })
      const resData: any = await response.json()
      if (resData.code !== 0) {
        if (allItems.length === 0) return c.json({ success: false, error: `B站拒绝了请求(code=${resData.code}): ${resData.message}` }, 401)
        break
      }
      const list = resData.data?.list || []
      if (list.length === 0) { emptyPage++; if (emptyPage >= 3) break; continue }
      emptyPage = 0
      for (const item of list) {
        allItems.push({ bvid: item.history?.bvid || item.bvid || '', title: item.title || '', pic: item.cover || (item.covers?.[0]) || '', author_name: item.author_name || item.owner?.name || '', author_mid: item.author_mid || item.owner?.mid || 0, view_at: item.view_at || 0, progress: item.progress ?? -1, duration: item.duration || 0, uri: item.uri || '' })
        if (totalLimit && allItems.length >= totalLimit) break
      }
      if (totalLimit && allItems.length >= totalLimit) break
      const cursor = resData.data?.cursor
      if (!cursor || (cursor.max === max && cursor.view_at === viewAt)) break
      max = cursor.max; viewAt = cursor.view_at
    }
    return c.json({ success: true, list: allItems })
  } catch (err: any) {
    return c.json({ success: false, error: `网络异常: ${err.message}` }, 500)
  }
})

// ==========================================
// Protected: history sync / list / delete / clear
// ==========================================
app.post('/api/history/sync', authGuard, async (c) => {
  const userId = c.get('userId')
  const { blindIndex, encryptedPayload, bvidRaw, titleRaw, authorNameRaw, authorMidRaw, viewAt } = await c.req.json()
  const storage = await getStorage(c.env)
  await storage.syncHistory({ userId, blindIndex, encryptedPayload, bvidRaw, titleRaw, authorNameRaw, authorMidRaw, viewAt })
  return c.json({ success: true })
})

app.post('/api/history/sync-batch', authGuard, async (c) => {
  const userId = c.get('userId')
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ success: false, error: '空列表' }, 400)
  const storage = await getStorage(c.env)
  for (const item of items) {
    await storage.syncHistory({ userId, ...item })
  }
  return c.json({ success: true, count: items.length })
})

app.get('/api/history/list', authGuard, async (c) => {
  const userId = c.get('userId')
  const storage = await getStorage(c.env)
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '20')
  const keyword = c.req.query('keyword') || ''
  const sortBy = c.req.query('sort_by') || 'view_at'
  const order = c.req.query('order') || 'DESC'
  const records = await storage.listHistory({ userId, keyword, sortBy, order, page, limit })
  const all = await storage.listHistory({ userId, keyword, sortBy, order, page: 1, limit: 999999 })
  return c.json({ success: true, records, total: all.length, page, limit })
})

app.post('/api/history/delete', authGuard, async (c) => {
  const userId = c.get('userId')
  const { blindIndex } = await c.req.json()
  if (!blindIndex) return c.json({ success: false, error: '缺少参数' }, 400)
  const storage = await getStorage(c.env)
  await storage.deleteHistory(userId, blindIndex)
  return c.json({ success: true })
})

app.post('/api/history/clear', authGuard, async (c) => {
  const userId = c.get('userId')
  const storage = await getStorage(c.env)
  await storage.clearHistory(userId)
  return c.json({ success: true })
})

// ==========================================
// Bootstrap
// ==========================================
// @ts-ignore
if (typeof globalThis.WebSocketPair === 'undefined') {
  const { serve } = await import('@hono/node-server')
  const { serveStatic } = await import('@hono/node-server/serve-static')
  app.use('*', serveStatic({ root: './dist' }))
  console.log('B站历史记录本地全栈服务器已拉起 -> http://localhost:8787')
  serve({ fetch: app.fetch, port: 8787 })
}

export default app
