import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'

export interface SyncRecord {
  userId: string
  blindIndex: string
  encryptedPayload: string
  viewAt: number
  bvidRaw?: string
  titleRaw?: string
  authorNameRaw?: string
  authorMidRaw?: number
}

export interface ListParams {
  userId: string
  keyword?: string
  sortBy?: string
  order?: string
  page?: number
  limit?: number
}

export interface StorageAdapter {
  readonly type: string
  createUser(id: string, username: string, passwordHash: string): Promise<{ success: boolean; error?: string }>
  getUserByUsername(username: string): Promise<any>
  getUserById(userId: string): Promise<any>
  getUserConfig(userId: string): Promise<any>
  saveUserConfig(userId: string, config: Record<string, any>): Promise<void>
  syncHistory(record: SyncRecord): Promise<void>
  listHistory(params: ListParams): Promise<any[]>
  deleteHistory(userId: string, blindIndex: string): Promise<void>
  clearHistory(userId: string): Promise<void>
}

// ==========================================
// D1 Adapter
// ==========================================
class D1Adapter implements StorageAdapter {
  readonly type = 'd1'
  private initialized = false

  constructor(private env: any) {}

  private async ensureTables() {
    if (this.initialized) return
    await this.env.DB.batch([
      this.env.DB.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT)'),
      this.env.DB.prepare('CREATE TABLE IF NOT EXISTS user_configs (user_id TEXT PRIMARY KEY, bili_cookie TEXT, encrypt_cookie INTEGER DEFAULT 0, is_auto_sync INTEGER DEFAULT 0, encrypt_enabled INTEGER DEFAULT 1, full_encrypt INTEGER DEFAULT 0, no_base64 INTEGER DEFAULT 0, fetch_limit INTEGER DEFAULT 30, fetch_max_pages INTEGER DEFAULT 5, auto_fetch_interval INTEGER DEFAULT 0, encrypt_algo TEXT DEFAULT \'AES-GCM-256\', public_key_pem TEXT, encrypted_private_key TEXT, private_key_iv TEXT, FOREIGN KEY (user_id) REFERENCES users(id))'),
      this.env.DB.prepare('CREATE TABLE IF NOT EXISTS watch_history (user_id TEXT NOT NULL, blind_index TEXT NOT NULL, encrypted_payload TEXT NOT NULL, view_at INTEGER NOT NULL, bvid_raw TEXT, title_raw TEXT, author_name_raw TEXT, author_mid_raw INTEGER DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, blind_index))'),
    ])
    // migrate missing columns on existing tables (D1 ALTER TABLE has no IF NOT EXISTS)
    const migCols: [string, string][] = [
      ['encrypt_cookie', 'INTEGER DEFAULT 0'],
      ['is_auto_sync', 'INTEGER DEFAULT 0'],
      ['encrypt_enabled', 'INTEGER DEFAULT 1'],
      ['full_encrypt', 'INTEGER DEFAULT 0'],
      ['no_base64', 'INTEGER DEFAULT 0'],
      ['fetch_limit', 'INTEGER DEFAULT 30'],
      ['fetch_max_pages', 'INTEGER DEFAULT 5'],
      ['auto_fetch_interval', 'INTEGER DEFAULT 0'],
      ['encrypt_algo', 'TEXT DEFAULT \'AES-GCM-256\''],
      ['public_key_pem', 'TEXT'],
      ['encrypted_private_key', 'TEXT'],
      ['private_key_iv', 'TEXT'],
    ]
    for (const [col, def] of migCols) {
      try { await this.env.DB.prepare(`ALTER TABLE user_configs ADD COLUMN ${col} ${def}`).run() } catch {}
    }
    this.initialized = true
  }

  async createUser(id: string, username: string, passwordHash: string) {
    await this.ensureTables()
    try {
      await this.env.DB.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').bind(id, username, passwordHash).run()
      return { success: true }
    } catch {
      return { success: false, error: '用户名已存在' }
    }
  }

  async getUserByUsername(username: string) {
    await this.ensureTables()
    const { results } = await this.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).all()
    return results[0] || null
  }

  async getUserById(userId: string) {
    await this.ensureTables()
    const { results } = await this.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).all()
    return results[0] || null
  }

  async getUserConfig(userId: string) {
    await this.ensureTables()
    const { results } = await this.env.DB.prepare('SELECT * FROM user_configs WHERE user_id = ?').bind(userId).all()
    return results[0] || {}
  }

  async saveUserConfig(userId: string, config: Record<string, any>) {
    await this.ensureTables()
    const { biliCookie, encryptCookie, isAutoSync, encryptEnabled, fullEncrypt, noBase64, fetchLimit, fetchMaxPages, autoFetchInterval, encryptAlgo, publicKeyPem, encryptedPrivateKey, privateKeyIv } = config
    await this.env.DB.prepare(
      `INSERT INTO user_configs (user_id, bili_cookie, encrypt_cookie, is_auto_sync, encrypt_enabled, full_encrypt, no_base64, fetch_limit, fetch_max_pages, auto_fetch_interval, encrypt_algo, public_key_pem, encrypted_private_key, private_key_iv)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         bili_cookie=excluded.bili_cookie,
         encrypt_cookie=excluded.encrypt_cookie,
         is_auto_sync=excluded.is_auto_sync,
         encrypt_enabled=excluded.encrypt_enabled,
         full_encrypt=excluded.full_encrypt,
         no_base64=excluded.no_base64,
         fetch_limit=excluded.fetch_limit,
         fetch_max_pages=excluded.fetch_max_pages,
         auto_fetch_interval=excluded.auto_fetch_interval,
         encrypt_algo=excluded.encrypt_algo,
         public_key_pem=excluded.public_key_pem,
         encrypted_private_key=excluded.encrypted_private_key,
         private_key_iv=excluded.private_key_iv`,
    ).bind(userId, biliCookie || null, encryptCookie ?? 0, isAutoSync ?? 0, encryptEnabled ?? 1, fullEncrypt ?? 0, noBase64 ?? 0, fetchLimit ?? 30, fetchMaxPages ?? 5, autoFetchInterval ?? 0, encryptAlgo || 'AES-GCM-256', publicKeyPem || null, encryptedPrivateKey || null, privateKeyIv || null).run()
  }

  async syncHistory(record: SyncRecord) {
    await this.ensureTables()
    const now = Date.now()
    await this.env.DB.prepare(
      `INSERT INTO watch_history (user_id, blind_index, encrypted_payload, view_at, bvid_raw, title_raw, author_name_raw, author_mid_raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, blind_index) DO UPDATE SET
         encrypted_payload=excluded.encrypted_payload,
         view_at=excluded.view_at,
         bvid_raw=excluded.bvid_raw,
         title_raw=excluded.title_raw,
         author_name_raw=excluded.author_name_raw,
         author_mid_raw=excluded.author_mid_raw,
         updated_at=excluded.updated_at`,
    ).bind(record.userId, record.blindIndex, record.encryptedPayload, record.viewAt || Math.floor(Date.now() / 1000), record.bvidRaw || '', record.titleRaw || '', record.authorNameRaw || '', record.authorMidRaw || 0, now).run()
  }

  async listHistory(params: ListParams) {
    await this.ensureTables()
    const userId = params.userId
    const keyword = params.keyword || ''
    const sortBy = params.sortBy || 'view_at'
    const order = params.order === 'ASC' ? 'ASC' : 'DESC'
    const page = params.page || 1
    const limit = Math.min(params.limit || 20, 9999)
    const offset = (page - 1) * limit
    const validSort = ['view_at', 'title_raw', 'author_name_raw', 'updated_at']
    const finalSort = validSort.includes(sortBy) ? sortBy : 'view_at'
    if (keyword) {
      const { results } = await this.env.DB.prepare(`SELECT * FROM watch_history WHERE user_id = ? AND (title_raw LIKE ? OR author_name_raw LIKE ? OR bvid_raw LIKE ?) ORDER BY ${finalSort} ${order} LIMIT ? OFFSET ?`).bind(userId, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, limit, offset).all()
      return results
    }
    const { results } = await this.env.DB.prepare(`SELECT * FROM watch_history WHERE user_id = ? ORDER BY ${finalSort} ${order} LIMIT ? OFFSET ?`).bind(userId, limit, offset).all()
    return results
  }

  async deleteHistory(userId: string, blindIndex: string) {
    await this.ensureTables()
    await this.env.DB.prepare('DELETE FROM watch_history WHERE user_id = ? AND blind_index = ?').bind(userId, blindIndex).run()
  }

  async clearHistory(userId: string) {
    await this.ensureTables()
    await this.env.DB.prepare('DELETE FROM watch_history WHERE user_id = ?').bind(userId).run()
  }
}

// ==========================================
// SQLite Adapter
// ==========================================
let _sqliteDb: any = null

async function getSqliteDb() {
  if (_sqliteDb) return _sqliteDb
  const Database = (await import('better-sqlite3')).default
  _sqliteDb = new Database('bili_vault.db')
    _sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT);
    CREATE TABLE IF NOT EXISTS user_configs (user_id TEXT PRIMARY KEY, bili_cookie TEXT, encrypt_cookie INTEGER DEFAULT 0, is_auto_sync INTEGER DEFAULT 0, encrypt_enabled INTEGER DEFAULT 1, full_encrypt INTEGER DEFAULT 0, no_base64 INTEGER DEFAULT 0, fetch_limit INTEGER DEFAULT 30, fetch_max_pages INTEGER DEFAULT 5, auto_fetch_interval INTEGER DEFAULT 0, encrypt_algo TEXT DEFAULT 'AES-GCM-256', public_key_pem TEXT, encrypted_private_key TEXT, private_key_iv TEXT, FOREIGN KEY (user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS watch_history (user_id TEXT NOT NULL, blind_index TEXT NOT NULL, encrypted_payload TEXT NOT NULL, view_at INTEGER NOT NULL, bvid_raw TEXT, title_raw TEXT, author_name_raw TEXT, author_mid_raw INTEGER DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, blind_index));
  `)
  // migrate missing columns
  try { _sqliteDb.exec(`ALTER TABLE user_configs ADD COLUMN no_base64 INTEGER DEFAULT 0`) } catch {}
  try { _sqliteDb.exec(`ALTER TABLE user_configs ADD COLUMN encrypt_algo TEXT DEFAULT 'AES-GCM-256'`) } catch {}
  try { _sqliteDb.exec(`ALTER TABLE user_configs ADD COLUMN encrypted_private_key TEXT`) } catch {}
  try { _sqliteDb.exec(`ALTER TABLE user_configs ADD COLUMN private_key_iv TEXT`) } catch {}
  return _sqliteDb
}

class SqliteAdapter implements StorageAdapter {
  readonly type = 'sqlite'
  private async db() { return getSqliteDb() }

  async createUser(id: string, username: string, passwordHash: string) {
    try {
      ;(await this.db()).prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username, passwordHash)
      return { success: true }
    } catch {
      return { success: false, error: '用户名已存在' }
    }
  }

  async getUserByUsername(username: string) {
    return (await this.db()).prepare('SELECT * FROM users WHERE username = ?').get(username) || null
  }

  async getUserById(userId: string) {
    return (await this.db()).prepare('SELECT * FROM users WHERE id = ?').get(userId) || null
  }

  async getUserConfig(userId: string) {
    return (await this.db()).prepare('SELECT * FROM user_configs WHERE user_id = ?').get(userId) || {}
  }

  async saveUserConfig(userId: string, config: Record<string, any>) {
    const { biliCookie, encryptCookie, isAutoSync, encryptEnabled, fullEncrypt, noBase64, fetchLimit, fetchMaxPages, autoFetchInterval, encryptAlgo, publicKeyPem, encryptedPrivateKey, privateKeyIv } = config
    ;(await this.db()).prepare(
      `INSERT INTO user_configs (user_id, bili_cookie, encrypt_cookie, is_auto_sync, encrypt_enabled, full_encrypt, no_base64, fetch_limit, fetch_max_pages, auto_fetch_interval, encrypt_algo, public_key_pem, encrypted_private_key, private_key_iv)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         bili_cookie=excluded.bili_cookie,
         encrypt_cookie=excluded.encrypt_cookie,
         is_auto_sync=excluded.is_auto_sync,
         encrypt_enabled=excluded.encrypt_enabled,
         full_encrypt=excluded.full_encrypt,
         no_base64=excluded.no_base64,
         fetch_limit=excluded.fetch_limit,
         fetch_max_pages=excluded.fetch_max_pages,
         auto_fetch_interval=excluded.auto_fetch_interval,
         encrypt_algo=excluded.encrypt_algo,
         public_key_pem=excluded.public_key_pem,
         encrypted_private_key=excluded.encrypted_private_key,
         private_key_iv=excluded.private_key_iv`,
    ).run(userId, biliCookie || null, encryptCookie ?? 0, isAutoSync ?? 0, encryptEnabled ?? 1, fullEncrypt ?? 0, noBase64 ?? 0, fetchLimit ?? 30, fetchMaxPages ?? 5, autoFetchInterval ?? 0, encryptAlgo || 'AES-GCM-256', publicKeyPem || null, encryptedPrivateKey || null, privateKeyIv || null)
  }

  async syncHistory(record: SyncRecord) {
    const now = Date.now()
    ;(await this.db()).prepare(
      `INSERT INTO watch_history (user_id, blind_index, encrypted_payload, view_at, bvid_raw, title_raw, author_name_raw, author_mid_raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, blind_index) DO UPDATE SET
         encrypted_payload=excluded.encrypted_payload,
         view_at=excluded.view_at,
         bvid_raw=excluded.bvid_raw,
         title_raw=excluded.title_raw,
         author_name_raw=excluded.author_name_raw,
         author_mid_raw=excluded.author_mid_raw,
         updated_at=excluded.updated_at`,
    ).run(record.userId, record.blindIndex, record.encryptedPayload, record.viewAt || Math.floor(Date.now() / 1000), record.bvidRaw || '', record.titleRaw || '', record.authorNameRaw || '', record.authorMidRaw || 0, now)
  }

  async listHistory(params: ListParams) {
    const keyword = params.keyword || ''
    const sortBy = params.sortBy || 'view_at'
    const order = params.order === 'ASC' ? 'ASC' : 'DESC'
    const page = params.page || 1
    const limit = Math.min(params.limit || 20, 9999)
    const offset = (page - 1) * limit
    const validSort = ['view_at', 'title_raw', 'author_name_raw', 'updated_at']
    const finalSort = validSort.includes(sortBy) ? sortBy : 'view_at'
    if (keyword) {
      return (await this.db()).prepare(`SELECT * FROM watch_history WHERE user_id = ? AND (title_raw LIKE ? OR author_name_raw LIKE ? OR bvid_raw LIKE ?) ORDER BY ${finalSort} ${order} LIMIT ? OFFSET ?`).all(params.userId, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, limit, offset)
    }
    return (await this.db()).prepare(`SELECT * FROM watch_history WHERE user_id = ? ORDER BY ${finalSort} ${order} LIMIT ? OFFSET ?`).all(params.userId, limit, offset)
  }

  async deleteHistory(userId: string, blindIndex: string) {
    ;(await this.db()).prepare('DELETE FROM watch_history WHERE user_id = ? AND blind_index = ?').run(userId, blindIndex)
  }

  async clearHistory(userId: string) {
    ;(await this.db()).prepare('DELETE FROM watch_history WHERE user_id = ?').run(userId)
  }
}

// ==========================================
// JSON File Adapter
// ==========================================
class JsonFileAdapter implements StorageAdapter {
  readonly type = 'json'
  private basePath: string

  constructor() { this.basePath = process.env.JSON_STORAGE_PATH || './data' }

  private async ensureDir(dir: string) { if (!existsSync(dir)) await mkdir(dir, { recursive: true }) }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(file, 'utf-8')) } catch { return fallback }
  }

  private async writeJson(file: string, data: any) {
    await this.ensureDir(dirname(file))
    await writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
  }

  private userPath() { return join(this.basePath, '_users.json') }
  private configPath(userId: string) { return join(this.basePath, userId, '_config.json') }
  private historyPath(userId: string) { return join(this.basePath, userId, '_history.json') }

  async createUser(id: string, username: string, passwordHash: string) {
    const users = await this.readJson<{ id: string; username: string; password_hash: string }[]>(this.userPath(), [])
    if (users.some(u => u.username === username)) return { success: false, error: '用户名已存在' }
    users.push({ id, username, password_hash: passwordHash })
    await this.writeJson(this.userPath(), users)
    return { success: true }
  }

  async getUserByUsername(username: string) {
    const users = await this.readJson<any[]>(this.userPath(), [])
    return users.find(u => u.username === username) || null
  }

  async getUserById(userId: string) {
    const users = await this.readJson<any[]>(this.userPath(), [])
    return users.find(u => u.id === userId) || null
  }

  async getUserConfig(userId: string) { return this.readJson<any>(this.configPath(userId), {}) }

  async saveUserConfig(userId: string, config: Record<string, any>) {
    await this.writeJson(this.configPath(userId), {
      bili_cookie: config.biliCookie || null,
      encrypt_cookie: config.encryptCookie ?? 0,
      is_auto_sync: config.isAutoSync ?? 0,
      encrypt_enabled: config.encryptEnabled ?? 1,
      full_encrypt: config.fullEncrypt ?? 0,
      no_base64: config.noBase64 ?? 0,
      fetch_limit: config.fetchLimit ?? 30,
      fetch_max_pages: config.fetchMaxPages ?? 5,
      auto_fetch_interval: config.autoFetchInterval ?? 0,
      encrypt_algo: config.encryptAlgo || 'AES-GCM-256',
      public_key_pem: config.publicKeyPem || null,
      encrypted_private_key: config.encryptedPrivateKey || null,
      private_key_iv: config.privateKeyIv || null,
    })
  }

  async syncHistory(record: SyncRecord) {
    const records = await this.readJson<any[]>(this.historyPath(record.userId), [])
    const now = Date.now()
    const idx = records.findIndex(r => r.blind_index === record.blindIndex)
    const entry = { blind_index: record.blindIndex, encrypted_payload: record.encryptedPayload, view_at: record.viewAt || Math.floor(Date.now() / 1000), bvid_raw: record.bvidRaw || '', title_raw: record.titleRaw || '', author_name_raw: record.authorNameRaw || '', author_mid_raw: record.authorMidRaw || 0, updated_at: now }
    if (idx >= 0) records[idx] = { ...records[idx], ...entry }
    else records.push(entry)
    await this.writeJson(this.historyPath(record.userId), records)
  }

  async listHistory(params: ListParams) {
    let records = await this.readJson<any[]>(this.historyPath(params.userId), [])
    const keyword = (params.keyword || '').toLowerCase()
    if (keyword) records = records.filter(r => (r.title_raw || '').toLowerCase().includes(keyword) || (r.author_name_raw || '').toLowerCase().includes(keyword) || (r.bvid_raw || '').toLowerCase().includes(keyword))
    const sortBy = params.sortBy || 'view_at'
    const order = params.order === 'ASC' ? 1 : -1
    records.sort((a, b) => { const va = a[sortBy] ?? ''; const vb = b[sortBy] ?? ''; if (typeof va === 'number') return (va - (vb as number)) * order; return String(va).localeCompare(String(vb)) * order })
    const page = params.page || 1
    const limit = Math.min(params.limit || 20, 9999)
    const offset = (page - 1) * limit
    return records.slice(offset, offset + limit)
  }

  async deleteHistory(userId: string, blindIndex: string) {
    const records = await this.readJson<any[]>(this.historyPath(userId), [])
    await this.writeJson(this.historyPath(userId), records.filter(r => r.blind_index !== blindIndex))
  }

  async clearHistory(userId: string) { await this.writeJson(this.historyPath(userId), []) }
}

// ==========================================
// WebDAV Adapter
// ==========================================
class WebDAVAdapter implements StorageAdapter {
  readonly type = 'webdav'
  private baseUrl: string
  private auth: string

  constructor() {
    this.baseUrl = (process.env.WEBDAV_URL || '').replace(/\/+$/, '')
    this.auth = 'Basic ' + btoa(`${process.env.WEBDAV_USERNAME || ''}:${process.env.WEBDAV_PASSWORD || ''}`)
  }

  private async webdavFetch(method: string, path: string, body?: BodyInit | null) {
    const res = await fetch(`${this.baseUrl}/${path}`, { method, headers: { 'Authorization': this.auth, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) }, body })
    return res
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    const res = await this.webdavFetch('GET', path)
    if (!res.ok) return fallback
    return JSON.parse(await res.text())
  }

  private async writeJson(path: string, data: any) {
    const body = JSON.stringify(data, null, 2)
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/')
      if (dirPath) await this.webdavFetch('MKCOL', dirPath + '/')
    }
    await this.webdavFetch('PUT', path, body)
  }

  async createUser(id: string, username: string, passwordHash: string) {
    const users = await this.readJson<{ id: string; username: string; password_hash: string }[]>('_users.json', [])
    if (users.some(u => u.username === username)) return { success: false, error: '用户名已存在' }
    users.push({ id, username, password_hash: passwordHash })
    await this.writeJson('_users.json', users)
    return { success: true }
  }

  async getUserByUsername(username: string) {
    const users = await this.readJson<any[]>('_users.json', [])
    return users.find(u => u.username === username) || null
  }

  async getUserById(userId: string) {
    const users = await this.readJson<any[]>('_users.json', [])
    return users.find(u => u.id === userId) || null
  }

  async getUserConfig(userId: string) { return this.readJson<any>(`${userId}/_config.json`, {}) }

  async saveUserConfig(userId: string, config: Record<string, any>) {
    await this.writeJson(`${userId}/_config.json`, {
      bili_cookie: config.biliCookie || null,
      encrypt_cookie: config.encryptCookie ?? 0,
      is_auto_sync: config.isAutoSync ?? 0,
      encrypt_enabled: config.encryptEnabled ?? 1,
      full_encrypt: config.fullEncrypt ?? 0,
      no_base64: config.noBase64 ?? 0,
      fetch_limit: config.fetchLimit ?? 30,
      fetch_max_pages: config.fetchMaxPages ?? 5,
      auto_fetch_interval: config.autoFetchInterval ?? 0,
      encrypt_algo: config.encryptAlgo || 'AES-GCM-256',
      public_key_pem: config.publicKeyPem || null,
      encrypted_private_key: config.encryptedPrivateKey || null,
      private_key_iv: config.privateKeyIv || null,
    })
  }

  async syncHistory(record: SyncRecord) {
    const path = `${record.userId}/_history.json`
    const records = await this.readJson<any[]>(path, [])
    const now = Date.now()
    const idx = records.findIndex(r => r.blind_index === record.blindIndex)
    const entry = { blind_index: record.blindIndex, encrypted_payload: record.encryptedPayload, view_at: record.viewAt || Math.floor(Date.now() / 1000), bvid_raw: record.bvidRaw || '', title_raw: record.titleRaw || '', author_name_raw: record.authorNameRaw || '', author_mid_raw: record.authorMidRaw || 0, updated_at: now }
    if (idx >= 0) records[idx] = { ...records[idx], ...entry }
    else records.push(entry)
    await this.writeJson(path, records)
  }

  async listHistory(params: ListParams) {
    let records = await this.readJson<any[]>(`${params.userId}/_history.json`, [])
    const keyword = (params.keyword || '').toLowerCase()
    if (keyword) records = records.filter(r => (r.title_raw || '').toLowerCase().includes(keyword) || (r.author_name_raw || '').toLowerCase().includes(keyword) || (r.bvid_raw || '').toLowerCase().includes(keyword))
    const sortBy = params.sortBy || 'view_at'
    const order = params.order === 'ASC' ? 1 : -1
    records.sort((a, b) => { const va = a[sortBy] ?? ''; const vb = b[sortBy] ?? ''; if (typeof va === 'number') return (va - (vb as number)) * order; return String(va).localeCompare(String(vb)) * order })
    const page = params.page || 1
    const limit = Math.min(params.limit || 20, 9999)
    const offset = (page - 1) * limit
    return records.slice(offset, offset + limit)
  }

  async deleteHistory(userId: string, blindIndex: string) {
    const records = await this.readJson<any[]>(`${userId}/_history.json`, [])
    await this.writeJson(`${userId}/_history.json`, records.filter(r => r.blind_index !== blindIndex))
  }

  async clearHistory(userId: string) { await this.writeJson(`${userId}/_history.json`, []) }
}

// ==========================================
// Factory
// ==========================================
let _cachedAdapter: StorageAdapter | null = null

export async function getStorage(env?: any): Promise<StorageAdapter> {
  if (env?.DB) return new D1Adapter(env)
  if (_cachedAdapter) return _cachedAdapter
  const backend = process.env.STORAGE_BACKEND || 'sqlite'
  switch (backend) {
    case 'd1': throw new Error('D1 后端仅在 Cloudflare Workers 环境中可用 (需要 env.DB)')
    case 'json': _cachedAdapter = new JsonFileAdapter(); break
    case 'webdav': _cachedAdapter = new WebDAVAdapter(); break
    default: _cachedAdapter = new SqliteAdapter()
  }
  return _cachedAdapter
}
