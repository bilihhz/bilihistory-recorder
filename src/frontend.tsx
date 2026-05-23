import { render } from 'solid-js/web'
import { createSignal, createResource, createEffect, Show, For, createMemo, onCleanup } from 'solid-js'
import { deriveKey, generateBlindIndex, encryptData, decryptData, generateRSAKeyPair, exportPublicKeyPem, wrapRSAPrivateKey, unwrapRSAPrivateKey, hybridEncrypt, hybridDecrypt } from './crypto'

const api = (path: string, opts: any = {}) => fetch(path, {
  ...opts,
  headers: {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
    ...(localStorage.getItem('token') ? { Authorization: 'Bearer ' + localStorage.getItem('token') } : {}),
  },
})

function App() {
  const [username, setUsername] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [session, setSession] = createSignal<any>(null)
  const [tab, setTab] = createSignal('history')
  const [theme, setTheme] = createSignal(localStorage.getItem('theme') || 'system')

  // Apply theme
  createEffect(() => {
    const t = theme()
    const isLight = t === 'light' || (t === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
    document.documentElement.classList.toggle('light', isLight)
    localStorage.setItem('theme', t)
  })
  // Listen for system theme changes
  createEffect(() => {
    if (theme() !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => {
      document.documentElement.classList.toggle('light', mq.matches)
      localStorage.setItem('theme', 'system')
    }
    mq.addEventListener('change', handler)
    onCleanup(() => mq.removeEventListener('change', handler))
  })

  const [keyword, setKeyword] = createSignal('')
  const [sortBy, setSortBy] = createSignal('view_at')
  const [order, setOrder] = createSignal('DESC')
  const [page, setPage] = createSignal(1)

  const [biliCookie, setBiliCookie] = createSignal('')
  const [encryptCookie, setEncryptCookie] = createSignal(true)
  const [autoSync, setAutoSync] = createSignal(false)
  const [encryptEnabled, setEncryptEnabled] = createSignal(true)
  const [noBase64, setNoBase64] = createSignal(false)
  const [fullEncrypt, setFullEncrypt] = createSignal(false)
  const [fetchLimit, setFetchLimit] = createSignal(100)
  const [autoFetchInterval, setAutoFetchInterval] = createSignal(0)
  const [encryptAlgo, setEncryptAlgo] = createSignal(localStorage.getItem('encryptAlgo') || 'AES-GCM-256')
  const [isFetching, setIsFetching] = createSignal(false)
  const [backendType, setBackendType] = createSignal('')
  const [logs, setLogs] = createSignal<{ t: string; m: string }[]>([])

  const addLog = (m: string) => setLogs(p => [{ t: new Date().toLocaleTimeString(), m }, ...p])

  // Auto-fetch timer
  createEffect(() => {
    const interval = autoFetchInterval()
    if (interval <= 0 || !session()) return
    const id = setInterval(() => runFetch(), interval * 60 * 1000)
    addLog(`自动抓取已启动: 每 ${interval} 分钟`)
    onCleanup(() => { clearInterval(id); addLog('自动抓取已停止') })
  })

  // Fetch storage backend info on mount
  api('/api/storage/info').then(r => r.json()).then(d => setBackendType(d.type || '')).catch(() => {})

  // Restore session from localStorage on mount
  createEffect(() => {
    const token = localStorage.getItem('token')
    const savedUser = localStorage.getItem('username')
    if (token && savedUser) {
      const savedPassword = localStorage.getItem('password') || ''
      api('/api/auth/verify', { method: 'POST' }).then(r => r.json()).then(d => {
        if (d.success) {
          const salt = `${savedUser}_bili_vault_entropy`
          const algo = localStorage.getItem('encryptAlgo') || 'AES-GCM-256'
          deriveKey(savedPassword, salt, algo as any).then(cryptoKey => {
            setSession({ id: d.userId, name: savedUser, cryptoKey, rawPassword: savedPassword })
            loadConfig(d.userId)
          })
        } else {
          localStorage.removeItem('token')
          localStorage.removeItem('username')
        }
      }).catch(() => {})
    }
  })

  const handleAuth = async (action: 'login' | 'register') => {
    if (!username() || !password()) return alert('请填写账户和密码')
    const salt = `${username()}_bili_vault_entropy`
    const cryptoKey = await deriveKey(password(), salt, encryptAlgo() as any)
    const passwordHash = await generateBlindIndex(password(), username())

    const res = await api(`/api/auth/${action}`, {
      method: 'POST',
      body: JSON.stringify({ username: username(), passwordHash }),
    })
    const data = await res.json()
    if (data.success) {
      localStorage.setItem('token', data.token)
      localStorage.setItem('username', username())
      localStorage.setItem('password', password())
      localStorage.setItem('encryptAlgo', encryptAlgo())
      setSession({ id: data.userId, name: username(), cryptoKey, rawPassword: password(), encryptAlgo: encryptAlgo() })
      addLog(action === 'register' ? '注册成功: ' + username() : '登录成功: ' + username())
      loadConfig(data.userId)
      api('/api/storage/info').then(r => r.json()).then(d => setBackendType(d.type || '')).catch(() => {})
    } else {
      alert(`认证失败: ${data.error}`)
    }
  }

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('username')
    localStorage.removeItem('password')
    setSession(null)
    setPage(1)
    addLog('已登出')
  }

  const loadConfig = async (userId: string) => {
    const res = await api(`/api/user/config?userId=${userId}`)
    const data = await res.json()
    if (data.success && data.config) {
      const cfg = data.config
      if (cfg.bili_cookie) {
        try {
          if (cfg.encrypt_cookie && session()?.cryptoKey) {
            const plain = await decryptData(cfg.bili_cookie, session().cryptoKey)
            setBiliCookie(plain)
          } else {
            setBiliCookie(cfg.bili_cookie)
          }
        } catch { setBiliCookie(cfg.bili_cookie) }
      }
      setEncryptCookie(cfg.encrypt_cookie === 1)
      setAutoSync(cfg.is_auto_sync === 1)
      setEncryptEnabled(cfg.encrypt_enabled === 1)
      setNoBase64(cfg.no_base64 === 1)
      setFullEncrypt(cfg.full_encrypt === 1)
      setFetchLimit(cfg.fetch_limit || 100)
      setFetchMaxPages(cfg.fetch_max_pages || 5)
      setAutoFetchInterval(cfg.auto_fetch_interval || 0)
      if (cfg.encrypt_algo) {
        const s = session()
        if (s && s.encryptAlgo !== cfg.encrypt_algo && s.rawPassword) {
          const salt = `${s.name}_bili_vault_entropy`
          const newKey = await deriveKey(s.rawPassword, salt, cfg.encrypt_algo as any)
          let rsaKeys = s.rsaKeys
          if (cfg.encrypt_algo === 'RSA-HYBRID' && cfg.encrypted_private_key && cfg.private_key_iv) {
            try {
              const kek = await deriveKey(s.rawPassword, salt, 'RSA-HYBRID')
              const rsaPriv = await unwrapRSAPrivateKey(cfg.encrypted_private_key, cfg.private_key_iv, kek as CryptoKey)
              const rsaPub = await window.crypto.subtle.importKey('spki', new Uint8Array(atob(cfg.public_key_pem.replace(/-----.*?-----/g, '')).split('').map(c => c.charCodeAt(0))), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt', 'wrapKey'])
              rsaKeys = { publicKey: rsaPub, privateKey: rsaPriv }
            } catch {}
          }
          setSession({ ...s, cryptoKey: newKey, encryptAlgo: cfg.encrypt_algo, rsaKeys })
        }
        setEncryptAlgo(cfg.encrypt_algo)
        localStorage.setItem('encryptAlgo', cfg.encrypt_algo)
      }
      // Unwrap RSA key if not done above
      const curS = session()
      if (cfg.encrypt_algo === 'RSA-HYBRID' && cfg.encrypted_private_key && cfg.private_key_iv && curS && !curS.rsaKeys) {
        try {
          const kek = await deriveKey(curS.rawPassword, `${curS.name}_bili_vault_entropy`, 'RSA-HYBRID')
          const rsaPriv = await unwrapRSAPrivateKey(cfg.encrypted_private_key, cfg.private_key_iv, kek as CryptoKey)
          const derB64 = cfg.public_key_pem.replace(/-----.*?-----/g, '').replace(/\s/g, '')
          const rsaPub = await window.crypto.subtle.importKey('spki', new Uint8Array(atob(derB64).split('').map(c => c.charCodeAt(0))), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt', 'wrapKey'])
          setSession({ ...curS, rsaKeys: { publicKey: rsaPub, privateKey: rsaPriv } })
        } catch {}
      }
    }
  }

  const saveConfig = async () => {
    if (!session()) return
    let cookieToSave = biliCookie()
    const s = session()
    if (encryptCookie() && cookieToSave && s.cryptoKey) {
      cookieToSave = await encryptData(cookieToSave, s.cryptoKey)
    }
    let publicKeyPem = null, encryptedPrivateKey = null, privateKeyIv = null
    let rsaKeys = s.rsaKeys
    const isRSA = encryptAlgo() === 'RSA-HYBRID'
    const algoChanged = s.encryptAlgo !== encryptAlgo()
    if (isRSA && (algoChanged || !rsaKeys)) {
      const rsa = await generateRSAKeyPair()
      publicKeyPem = await exportPublicKeyPem(rsa.publicKey)
      const kek = await deriveKey(s.rawPassword, `${s.name}_bili_vault_entropy`, 'RSA-HYBRID')
      const wrapped = await wrapRSAPrivateKey(rsa.privateKey, kek as CryptoKey)
      encryptedPrivateKey = wrapped.wrappedKey
      privateKeyIv = wrapped.iv
      rsaKeys = rsa
    }
    await api('/api/user/config', {
      method: 'POST',
      body: JSON.stringify({
        biliCookie: cookieToSave,
        encryptCookie: encryptCookie() ? 1 : 0,
        isAutoSync: autoSync() ? 1 : 0,
        encryptEnabled: encryptEnabled() ? 1 : 0,
        noBase64: noBase64() ? 1 : 0,
        fullEncrypt: fullEncrypt() ? 1 : 0,
        fetchLimit: fetchLimit(),
        autoFetchInterval: autoFetchInterval(),
        encryptAlgo: encryptAlgo(),
        publicKeyPem,
        encryptedPrivateKey,
        privateKeyIv,
      }),
    })
    if (algoChanged && s.rawPassword) {
      const salt = `${s.name}_bili_vault_entropy`
      const newKey = await deriveKey(s.rawPassword, salt, encryptAlgo() as any)
      setSession({ ...s, cryptoKey: newKey, encryptAlgo: encryptAlgo(), rsaKeys })
      localStorage.setItem('encryptAlgo', encryptAlgo())
    }
    addLog(`配置已保存 (算法:${encryptAlgo()} RSA:${isRSA?'密钥已生成':'无'} Cookie加密:${encryptCookie()?'开':'关'})`)
  }

  const runFetch = async () => {
    if (!biliCookie()) { addLog('抓取失败: 未填写 Cookie'); return }
    if (!session()) return
    setIsFetching(true)
    try {
      const res = await api('/api/bili/fetch', {
        method: 'POST',
        body: JSON.stringify({ cookie: biliCookie(), limit: fetchLimit() }),
      })
      const result = await res.json()
      if (!result.success) throw new Error(result.error)

      const encOn = encryptEnabled()
      const fullOn = fullEncrypt()
      const key = session().cryptoKey
      const rawPw = session().rawPassword
      const rsaKeys = session().rsaKeys

      // Parallel encrypt all items, then batch sync
      const items = await Promise.all(result.list.map(async (item: any) => {
        const [blindIndex, encryptedPayload] = await Promise.all([
          generateBlindIndex(item.bvid, rawPw),
          (async () => {
            const payload = JSON.stringify({ bvid: item.bvid, title: item.title, pic: item.pic, author: item.author_name, authorMid: item.author_mid, progress: item.progress, duration: item.duration, uri: item.uri, viewAt: item.view_at * 1000 })
            if (!encOn) return noBase64() ? payload : btoa(unescape(encodeURIComponent(payload)))
            if (encryptAlgo() === 'RSA-HYBRID' && rsaKeys) return await hybridEncrypt(payload, rsaKeys.publicKey)
            return await encryptData(payload, key)
          })(),
        ])
        return { blindIndex, encryptedPayload, bvidRaw: fullOn ? '' : item.bvid, titleRaw: fullOn ? '' : item.title, authorNameRaw: fullOn ? '' : item.author_name, authorMidRaw: fullOn ? 0 : item.author_mid, viewAt: item.view_at }
      }))

      await api('/api/history/sync-batch', { method: 'POST', body: JSON.stringify({ items }) })
      addLog(`同步成功: ${items.length} 条`)
      refetch()
    } catch (err: any) {
      addLog(`抓取失败: ${err.message}`)
    } finally {
      setIsFetching(false)
    }
  }

  const [historyData, { refetch }] = createResource(
    () => ({ p: page(), s: sortBy(), o: order(), k: keyword(), uid: session()?.id, fullOn: fullEncrypt(), encOn: encryptEnabled(), noB64: noBase64() }),
    async ({ p, s, o, k, uid, fullOn, encOn, noB64 }) => {
      if (!uid) return { records: [], total: 0 }
      const params = new URLSearchParams({ sort_by: s, order: o, page: String(p) })
      if (k && !fullOn) params.set('keyword', k)
      const res = await api(`/api/history/list?${params}`)
      const data = await res.json()
      const rows = data.success ? data.records : []
      const key = session()!.cryptoKey
      const rsaKeys = session()!.rsaKeys
      const decoded = await Promise.all(rows.map(async (r: any) => {
        let d: any = null
        try {
          const ep = r.encrypted_payload
          let raw: string
          if (encOn && ep.startsWith('rsa:') && rsaKeys) {
            raw = await hybridDecrypt(ep, rsaKeys.privateKey)
          } else if (encOn) {
            raw = await decryptData(ep, key)
          } else if (noB64) {
            raw = ep
          } else {
            raw = decodeURIComponent(escape(atob(ep)))
          }
          d = JSON.parse(raw)
        } catch {}
        return { ...r, _d: d }
      }))
      return { records: decoded, total: data.total || 0 }
    },
  )

  const processedList = createMemo(() => {
    const rows = historyData()?.records || []
    const kw = keyword().toLowerCase().trim()
    if (!kw) return rows
    return rows.filter((r: any) => {
      const d = r._d
      if (d) return (d.title || '').toLowerCase().includes(kw) || (d.author || '').toLowerCase().includes(kw) || (d.bvid || '').toLowerCase().includes(kw)
      return (r.title_raw || '').toLowerCase().includes(kw) || (r.author_name_raw || '').toLowerCase().includes(kw) || (r.bvid_raw || '').toLowerCase().includes(kw)
    })
  })

  const totalItems = createMemo(() => historyData()?.total || 0)
  const totalPages = createMemo(() => Math.ceil(totalItems() / 20) || 1)

  const formatProgress = (p: number, d: number) => {
    if (p === -1 || p === undefined) return '已看完'
    const pm = Math.floor(p / 60); const ps = p % 60
    if (!d) return `${pm}分${ps}秒`
    const dm = Math.floor(d / 60); const ds = d % 60
    return `${pm}分${ps}秒 / ${dm}分${ds}秒`
  }

  const formatViewAt = (info: any, raw: any) => {
    const ms = info?.viewAt || (raw?.view_at ? raw.view_at * 1000 : 0)
    return ms ? new Date(ms).toLocaleString() : '未知'
  }

  const biliLink = (bvid: string) => bvid ? `https://www.bilibili.com/video/${bvid}` : '#'

  const clearAllHistory = async () => {
    if (!session()) return
    if (!confirm('确定清空所有历史记录？此操作不可恢复。')) return
    await api('/api/history/clear', { method: 'POST', body: JSON.stringify({}) })
    addLog('已清空所有历史记录')
    refetch()
  }

  const themeIcon = () => {
    const t = theme()
    if (t === 'light') return '☀️'
    if (t === 'dark') return '🌙'
    return '💻'
  }
  const cycleTheme = () => {
    const order = ['dark', 'light', 'system']
    const idx = order.indexOf(theme())
    setTheme(order[(idx + 1) % 3])
  }

  return (
    <div class="p-4 sm:p-6 max-w-6xl mx-auto font-sans">
      <header class="border-b border-gray-800 pb-3 sm:pb-4 mb-4 sm:mb-6 flex justify-between items-center gap-2">
        <h1 class="text-lg sm:text-2xl font-bold text-blue-400 truncate">Bili 历史记录</h1>
        <div class="flex items-center gap-2 flex-shrink-0">
          <button onClick={cycleTheme} class="text-xs bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-gray-400 transition" title={`主题: ${theme() === 'dark' ? '深色' : theme() === 'light' ? '浅色' : '跟随系统'}`}>{themeIcon()}</button>
          <Show when={session()}>
            <span class="text-xs text-green-400 font-mono hidden sm:inline">{session().name}</span>
            <button onClick={logout} class="text-xs bg-red-900/40 border border-red-700 px-2 py-0.5 rounded text-red-200">退出</button>
          </Show>
        </div>
      </header>

      <Show when={session()} fallback={
        <div class="max-w-md mx-auto bg-gray-900 p-6 rounded-xl border border-gray-800 shadow-2xl mt-8 sm:mt-12">
          <h2 class="text-lg font-bold text-gray-200 mb-4 text-center">登录 / 注册</h2>
          <div class="space-y-3">
            <input type="text" placeholder="用户名" class="w-full p-2 bg-gray-800 border border-gray-700 rounded text-sm text-white" value={username()} onInput={e => setUsername(e.currentTarget.value)} />
            <input type="password" placeholder="密码" class="w-full p-2 bg-gray-800 border border-gray-700 rounded text-sm text-white" value={password()} onInput={e => setPassword(e.currentTarget.value)} />
            <div class="flex gap-2 pt-2">
              <button onClick={() => handleAuth('register')} class="flex-1 text-xs bg-gray-800 hover:bg-gray-700 p-2.5 rounded text-gray-300">注册</button>
              <button onClick={() => handleAuth('login')} class="flex-1 text-xs bg-blue-600 hover:bg-blue-700 p-2.5 rounded font-bold text-white">登录</button>
            </div>
          </div>
        </div>
      }>
        <nav class="flex gap-1 sm:gap-2 mb-4 sm:mb-6 border-b border-gray-800 pb-2">
          <button onClick={() => { setTab('history'); setPage(1) }} class={`px-3 sm:px-4 py-2 text-xs sm:text-sm rounded-t transition-all ${tab() === 'history' ? 'bg-blue-600 text-white shadow' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>历史档案库</button>
          <button onClick={() => setTab('settings')} class={`px-3 sm:px-4 py-2 text-xs sm:text-sm rounded-t transition-all ${tab() === 'settings' ? 'bg-blue-600 text-white shadow' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>设置与同步</button>
          <button onClick={() => setTab('logs')} class={`px-3 sm:px-4 py-2 text-xs sm:text-sm rounded-t transition-all ${tab() === 'logs' ? 'bg-blue-600 text-white shadow' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>同步日志</button>
        </nav>

        <div class="tab-content">
        {/* ======== History ======== */}
        <Show when={tab() === 'history'}>
          <div class="space-y-4 animate-fade-in">
            <div class="flex flex-col sm:flex-row gap-2">
              <input type="text" placeholder={fullEncrypt() ? '全加密模式 · 本地搜索...' : '搜索标题 / UP主 / BV号...'} class="flex-1 p-2 bg-gray-800 border border-gray-700 rounded text-sm text-white" value={keyword()} onInput={e => { setKeyword(e.currentTarget.value); setPage(1) }} />
              <div class="flex gap-2">
                <select class="p-2 bg-gray-800 border border-gray-700 rounded text-sm text-white flex-1 sm:flex-none" value={sortBy()} onChange={e => setSortBy(e.currentTarget.value)}>
                  <option value="view_at">观看时间</option>
                  <option value="title_raw">标题</option>
                  <option value="author_name_raw">UP主</option>
                  <option value="updated_at">同步时间</option>
                </select>
                <select class="p-2 bg-gray-800 border border-gray-700 rounded text-sm text-white flex-1 sm:flex-none" value={order()} onChange={e => setOrder(e.currentTarget.value)}>
                  <option value="DESC">降序</option>
                  <option value="ASC">升序</option>
                </select>
              </div>
            </div>
            <Show when={historyData.loading}><div class="text-center text-gray-500 py-12 animate-pulse">加载中...</div></Show>
            <Show when={!historyData.loading && processedList().length === 0}>
              <div class="p-12 text-center text-gray-500 bg-gray-900/50 rounded-xl border border-dashed border-gray-800 text-sm">暂无记录，先去「设置与同步」填入 Cookie 抓取吧</div>
            </Show>
            <div key={page()} class="animate-page-in">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <For each={processedList()}>{r => {
                const d = r._d
                const pic = d?.pic || ''
                return (
                  <a href={biliLink(d?.bvid || r.bvid_raw || '')} target="_blank" rel="noopener noreferrer" class="bg-gray-900 rounded-lg border border-gray-800 p-3 flex gap-3 hover:border-blue-500 hover:shadow-lg hover:shadow-blue-900/20 transition-all duration-200 block no-underline text-inherit">
                    <img src={pic ? `/api/proxy/image?url=${encodeURIComponent(pic.replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://'))}` : ''} alt="封面" loading="lazy" class="w-24 sm:w-32 h-16 sm:h-20 object-cover rounded bg-gray-800 flex-shrink-0" onerror={(e: any) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="80" fill="%23222"><rect width="128" height="80"/><text x="64" y="44" text-anchor="middle" fill="%23555" font-size="12">无封面</text></svg>' }} />
                    <div class="flex flex-col justify-between min-w-0 flex-1">
                      <h4 class="text-xs font-bold text-gray-100 line-clamp-2" title={d?.title || r.title_raw}>{d?.title || r.title_raw || '(unknown)'}</h4>
                      <div class="space-y-0.5">
                        <p class="text-[11px] text-gray-400 truncate flex items-center gap-1"><span class="text-blue-400 font-mono text-[10px]">{d?.bvid || r.bvid_raw || ''}</span><span class="text-gray-600">|</span>{d?.author || r.author_name_raw || '未知'}</p>
                        <div class="flex justify-between items-center text-[10px] text-gray-500 font-mono"><span>{formatProgress(d?.progress ?? -1, d?.duration || 0)}</span><span>{formatViewAt(d, r)}</span></div>
                      </div>
                    </div>
                  </a>
                )
              }}</For>
            </div>
              <div class="flex justify-center items-center gap-3 pt-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page() === 1} class="text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded disabled:opacity-30 transition">上一页</button>
                <span class="text-xs text-gray-400">第 {page()} / {totalPages()} 页 · 共 {totalItems()} 条</span>
                <button onClick={() => setPage(p => Math.min(totalPages(), p + 1))} disabled={page() >= totalPages()} class="text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded disabled:opacity-30 transition">下一页</button>
              </div>
            </div>
          </div>
        </Show>

        {/* ======== Settings ======== */}
        <Show when={tab() === 'settings'}>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 animate-fade-in">
            <div class="space-y-4">
              <div class="bg-gray-900 p-4 sm:p-5 rounded-xl border border-gray-800 space-y-4">
                <h3 class="font-bold text-sm text-blue-400 flex items-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>B站账号绑定</h3>
                <div>
                  <label class="block text-xs text-gray-500 mb-1">SESSDATA Cookie</label>
                  <input type="text" placeholder="从浏览器 F12 → Application → Cookies → bilibili.com → SESSDATA 复制" class="w-full p-2 bg-gray-800 border border-gray-700 rounded text-xs font-mono text-white" value={biliCookie()} onInput={e => setBiliCookie(e.currentTarget.value)} />
                </div>
                <div class="flex items-center justify-between bg-gray-800/50 p-2.5 rounded">
                  <span class="text-xs text-gray-300">Cookie 加密存储</span>
                  <label class="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={encryptCookie()} onChange={e => setEncryptCookie(e.currentTarget.checked)} class="sr-only peer" />
                    <div class="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>
              </div>

              <div class="bg-gray-900 p-4 sm:p-5 rounded-xl border border-gray-800 space-y-4">
                <h3 class="font-bold text-sm text-yellow-400 flex items-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6l4 2"/><circle cx="12" cy="12" r="10"/></svg>抓取设置</h3>
                <div class="space-y-3">
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">抓取条数: <span class="text-white font-mono">{fetchLimit()}</span></label>
                    <input type="range" min="10" max="500" step="10" value={fetchLimit()} onInput={e => setFetchLimit(parseInt(e.currentTarget.value))} class="w-full accent-blue-500" />
                    <div class="flex justify-between text-[10px] text-gray-600"><span>10</span><span>500</span></div>
                  </div>
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">定时自动抓取: <span class="text-white font-mono">{autoFetchInterval() > 0 ? `每 ${autoFetchInterval()} 分钟` : '关闭'}</span></label>
                    <input type="number" min="0" max="1440" value={autoFetchInterval()} onInput={e => setAutoFetchInterval(parseInt(e.currentTarget.value) || 0)} class="w-full p-2 bg-gray-800 border border-gray-700 rounded text-xs text-white font-mono" />
                  </div>
                </div>
              </div>

              <div class="bg-gray-900 p-4 sm:p-5 rounded-xl border border-gray-800 space-y-4">
                <h3 class="font-bold text-sm text-green-400 flex items-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>数据加密设置</h3>
                <div class="bg-gray-800/30 p-3 rounded space-y-3">
                  <div class="flex items-center justify-between">
                    <div class="flex-1"><span class="text-xs font-medium text-gray-200">载荷加密</span><p class="text-[10px] text-gray-500 mt-0.5">关闭后数据纯文本或 Base64 存储</p></div>
                    <label class="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={encryptEnabled()} onChange={e => setEncryptEnabled(e.currentTarget.checked)} class="sr-only peer" />
                      <div class="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
                    </label>
                  </div>
                  <Show when={!encryptEnabled()}>
                  <div class="flex items-center justify-between">
                    <div class="flex-1"><span class="text-xs font-medium text-gray-200">跳过 Base64 编码</span><p class="text-[10px] text-gray-500 mt-0.5">数据以纯 JSON 明文存储</p></div>
                    <label class="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={noBase64()} onChange={e => setNoBase64(e.currentTarget.checked)} class="sr-only peer" />
                      <div class="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-orange-600"></div>
                    </label>
                  </div>
                  </Show>
                  <div class="flex items-center justify-between">
                    <div class="flex-1"><span class="text-xs font-medium text-gray-200">全字段加密 (标题/UP主/BV)</span><p class="text-[10px] text-gray-500 mt-0.5">开启后搜索字段在服务端不可见</p></div>
                    <label class="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={fullEncrypt()} onChange={e => setFullEncrypt(e.currentTarget.checked)} class="sr-only peer" />
                      <div class="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-red-600"></div>
                    </label>
                  </div>
                  <div class="flex items-center justify-between">
                    <div class="flex-1"><span class="text-xs font-medium text-gray-200">加密算法</span><p class="text-[10px] text-gray-500 mt-0.5">更改后仅影响新数据</p></div>
                    <select value={encryptAlgo()} onChange={e => setEncryptAlgo(e.currentTarget.value)} class="bg-gray-800 border border-gray-700 rounded text-xs text-white px-2 py-1.5">
                      <option value="AES-GCM-128">AES-GCM-128</option>
                      <option value="AES-GCM-256">AES-GCM-256</option>
                      <option value="AES-CBC-256">AES-CBC-256</option>
                      <option value="RSA-HYBRID">RSA-HYBRID (混合)</option>
                    </select>
                  </div>
                </div>
                <div class="text-[11px] leading-relaxed space-y-1">
                  <div class="flex items-center gap-1.5"><div class={`w-2 h-2 rounded-full ${encryptEnabled() ? 'bg-green-500' : 'bg-gray-500'}`}></div><span class="text-gray-400">载荷: {encryptEnabled() ? (encryptAlgo() === 'RSA-HYBRID' ? 'RSA-2048 + AES-256-GCM' : encryptAlgo()) : noBase64() ? '纯文本' : 'Base64'}</span></div>
                  <div class="flex items-center gap-1.5"><div class={`w-2 h-2 rounded-full ${fullEncrypt() ? 'bg-red-500' : 'bg-green-500'}`}></div><span class="text-gray-400">搜索字段: {fullEncrypt() ? '已隐藏 (本地搜索)' : '明文 (服务端搜索)'}</span></div>
                  <div class="flex items-center gap-1.5"><div class={`w-2 h-2 rounded-full ${encryptCookie() ? 'bg-blue-500' : 'bg-gray-500'}`}></div><span class="text-gray-400">Cookie: {encryptCookie() ? `${encryptAlgo()} 加密存储` : '明文存储'}</span></div>
                  <div class="flex items-center gap-1.5"><div class="w-2 h-2 rounded-full bg-blue-500"></div><span class="text-gray-400">盲索引: HMAC-SHA256 (始终启用)</span></div>
                </div>
              </div>
            </div>

            <div class="space-y-4">
              <div class="bg-gray-900 p-4 sm:p-5 rounded-xl border border-gray-800 space-y-4">
                <h3 class="font-bold text-sm text-purple-400 flex items-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>同步操作</h3>
                <button onClick={async () => { await saveConfig(); await runFetch() }} disabled={isFetching()} class="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 text-white p-2.5 rounded text-xs font-bold transition flex items-center justify-center gap-2">
                  <svg class={`w-4 h-4 ${isFetching() ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                  {isFetching() ? `正在抓取 (${fetchLimit()} 条)...` : '保存配置并抓取最新历史'}
                </button>
                <div class="text-[11px] text-gray-500 leading-relaxed bg-black/30 p-2.5 rounded border border-gray-800">
                  {encryptEnabled() ? `数据在浏览器中用 ${encryptAlgo()} 加密后传输，服务端仅存密文。` : '数据以 Base64 编码传输，服务端可解码查看。'}
                  <Show when={autoFetchInterval() > 0}><br/>定时抓取已开启: 每 {autoFetchInterval()} 分钟自动同步</Show>
                </div>
              </div>

              <div class="bg-gray-900 p-4 sm:p-5 rounded-xl border border-gray-800 space-y-4">
                <h3 class="font-bold text-sm text-orange-400 flex items-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>数据管理</h3>
                <div class="grid grid-cols-2 gap-2">
                  <button onClick={clearAllHistory} class="bg-red-900/40 border border-red-800 hover:bg-red-900/60 text-red-300 p-2 rounded text-xs transition">清空所有历史</button>
                  <button onClick={async () => {
                    if (!session()) return
                    const res = await api('/api/history/list?limit=9999')
                    const data = await res.json()
                    const blob = new Blob([JSON.stringify(data.records || [], null, 2)], { type: 'application/json' })
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(blob)
                    a.download = `bili_history_backup_${new Date().toISOString().slice(0, 10)}.json`
                    a.click()
                    addLog('导出备份 (' + (data.records?.length || 0) + ' 条)')
                  }} class="bg-blue-900/40 border border-blue-800 hover:bg-blue-900/60 text-blue-300 p-2 rounded text-xs transition">导出备份</button>
                </div>
                <p class="text-[10px] text-gray-500">备份数据含密文，需相同密钥才能解密查看。</p>
              </div>

              <div class="bg-gray-800/30 p-3 rounded space-y-2">
                <div class="flex items-center justify-between text-xs">
                  <span class="text-gray-400">存储模式</span>
                  <span class="font-mono text-gray-200"><Show when={backendType()} fallback="载入中...">{backendType().toUpperCase()}</Show></span>
                </div>
              </div>

              <button onClick={saveConfig} class="w-full bg-gray-700 hover:bg-gray-600 text-white p-2.5 rounded text-xs font-bold transition">保存所有配置</button>
            </div>
          </div>
        </Show>

        {/* ======== Logs ======== */}
        <Show when={tab() === 'logs'}>
          <div class="bg-gray-900 rounded-xl border border-gray-800 p-4 animate-fade-in">
            <h3 class="font-bold text-sm text-gray-300 mb-3 flex items-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>同步审计日志</h3>
            <div class="bg-black/60 p-4 rounded-lg text-xs font-mono max-h-[400px] overflow-y-auto space-y-1">
              <For each={logs()} fallback={<div class="text-gray-600">暂无日志</div>}>{log => <div class="text-gray-400">[{log.t}] {log.m}</div>}</For>
            </div>
          </div>
        </Show>
        </div>
      </Show>
      <footer class="mt-6 sm:mt-8 pt-3 sm:pt-4 border-t border-gray-800 flex items-center justify-between text-[10px] text-gray-600">
        <span class="hidden sm:inline">Bilibili 历史记录安全查看器</span>
        <span class="sm:hidden">Bili 历史记录</span>
        <span>
          <Show when={backendType()} fallback={<span>载入中...</span>}>
            <span class="font-mono text-gray-500">{backendType().toUpperCase()}</span>
          </Show>
        </span>
      </footer>
      <style>{`
        .tab-content { position: relative; }
        .animate-fade-in { animation: fadeIn 0.25s ease-out; }
        .animate-page-in { animation: pageIn 0.2s ease-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pageIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .light { --bg-page: #f8fafc; }
        .light .bg-gray-950 { background-color: #f8fafc !important; }
        .light .bg-gray-900 { background-color: #ffffff !important; }
        .light .bg-gray-900\\/50 { background-color: rgba(248,250,252,0.5) !important; }
        .light .bg-gray-800 { background-color: #f1f5f9 !important; }
        .light .bg-gray-800\\/30 { background-color: rgba(241,245,249,0.3) !important; }
        .light .bg-gray-800\\/50 { background-color: rgba(241,245,249,0.5) !important; }
        .light .bg-black\\/60 { background-color: rgba(226,232,240,0.6) !important; }
        .light .bg-black\\/30 { background-color: rgba(226,232,240,0.3) !important; }
        .light .text-gray-100 { color: #0f172a !important; }
        .light .text-gray-200 { color: #1e293b !important; }
        .light .text-gray-300 { color: #334155 !important; }
        .light .text-gray-400 { color: #475569 !important; }
        .light .text-gray-500 { color: #64748b !important; }
        .light .text-gray-600 { color: #94a3b8 !important; }
        .light .border-gray-800 { border-color: #e2e8f0 !important; }
        .light .border-gray-700 { border-color: #cbd5e1 !important; }
        .light .border-dashed.border-gray-800 { border-color: #cbd5e1 !important; }
        .light .hover\\:border-blue-500:hover { border-color: #3b82f6 !important; }
        .light .hover\\:border-blue-600:hover { border-color: #2563eb !important; }
        .light .hover\\:shadow-lg { box-shadow: 0 4px 12px rgba(0,0,0,0.06) !important; }
        .light input, .light select { color: #0f172a !important; background-color: #f8fafc !important; border-color: #cbd5e1 !important; }
        .light input::placeholder { color: #94a3b8 !important; }
        .light .bg-gray-700 { background-color: #e2e8f0 !important; color: #1e293b !important; }
        .light .hover\\:bg-gray-700:hover { background-color: #cbd5e1 !important; }
        .light .hover\\:bg-gray-600:hover { background-color: #94a3b8 !important; }
        .light .hover\\:bg-gray-700 { color: #0f172a !important; }
        .light .bg-blue-600 { background-color: #2563eb !important; color: white !important; }
        .light .hover\\:bg-blue-700:hover { background-color: #1d4ed8 !important; }
        .light .text-blue-400 { color: #2563eb !important; }
        .light .hover\\:border-blue-600:hover { border-color: #2563eb !important; }
        .light .text-green-400 { color: #16a34a !important; }
        .light .text-purple-400 { color: #9333ea !important; }
        .light .text-yellow-400 { color: #ca8a04 !important; }
        .light .text-orange-400 { color: #ea580c !important; }
        .light .text-red-200 { color: #dc2626 !important; }
        .light .text-red-300 { color: #dc2626 !important; }
        .light .bg-red-900\\/40 { background-color: rgba(254,226,226,0.5) !important; border-color: #fca5a5 !important; }
        .light .hover\\:bg-red-900\\/60:hover { background-color: rgba(254,202,202,0.6) !important; }
        .light .bg-blue-900\\/40 { background-color: rgba(219,234,254,0.5) !important; border-color: #93c5fd !important; }
        .light .hover\\:bg-blue-900\\/60:hover { background-color: rgba(191,219,254,0.6) !important; }
        .light .text-blue-300 { color: #2563eb !important; }
        .light .bg-gray-700 { background-color: #e2e8f0 !important; }
        .light .disabled\\:opacity-30:disabled { opacity: 0.4 !important; }
        .light select option { background: white; color: #0f172a; }
      `}</style>
    </div>
  )
}

render(() => <App />, document.getElementById('root')!)
