/** 甘肃广电官网：固定六路频道、公开频道接口与实时 HLS 清单。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const GANSU_PAGE = 'https://www.gstv.com.cn/#tv'
export const GANSU_CHANNEL_API = 'https://app-api.gstv.com.cn/gs/liveRoomConfig/getTvBroadcastLiveList'

const MEDIA_HOST = 'live.gstv.com.cn'
export const CHANNEL_LIST_TTL_MS = 60 * 1000
export const CHANNEL_LIST_RETRY_MS = 10 * 1000
export const CHANNEL_LIST_HARD_TTL_MS = 24 * 60 * 60 * 1000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'gansu-1', channelId: '1', rawName: '甘肃卫视', name: '甘肃卫视',
    logo: 'https://jiangsu-10.zos.ctyun.cn/gansu/xLrpDFBk%E5%8F%B0%E6%A0%87logo%201.png',
  }),
  Object.freeze({
    ref: 'gansu-2', channelId: '2', rawName: '文化影视', name: '甘肃文化影视',
    logo: 'https://jiangsu-10.zos.ctyun.cn/gansu/CrmDikeF%E5%8F%B0%E6%A0%87logo%201.png',
  }),
  Object.freeze({
    ref: 'gansu-3', channelId: '3', rawName: '移动电视', name: '甘肃移动电视',
    logo: 'https://jiangsu-10.zos.ctyun.cn/gansu/JkJhceTS%E5%8F%B0%E6%A0%87logo%201.png',
  }),
  Object.freeze({
    ref: 'gansu-4', channelId: '4', rawName: '少儿频道', name: '甘肃少儿',
    logo: 'https://jiangsu-10.zos.ctyun.cn/gansu/54miXK6U%E5%8F%B0%E6%A0%87logo%201.png',
  }),
  Object.freeze({
    ref: 'gansu-5', channelId: '5', rawName: '科教频道', name: '甘肃科教',
    logo: 'https://jiangsu-10.zos.ctyun.cn/gansu/Ed2uoe2E%E5%8F%B0%E6%A0%87logo%201.png',
  }),
  Object.freeze({
    ref: 'gansu-6', channelId: '6', rawName: '公共应急', name: '甘肃公共应急',
    logo: 'https://jiangsu-10.zos.ctyun.cn/gansu/BQA3i9B4%E5%8F%B0%E6%A0%87logo%201.png',
  }),
])

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

function safeUrl(raw, label) {
  try {
    return new URL(String(raw || '').trim())
  } catch {
    throw new Error(`甘肃广电返回了无效${label}地址`)
  }
}

export function officialAssetUrl(raw) {
  const url = safeUrl(raw, '媒体')
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || url.hostname !== MEDIA_HOST || !url.pathname.startsWith('/live/')
      || /%2f|%5c/i.test(url.pathname) || url.hash) {
    throw new Error('甘肃广电返回了非官方媒体地址')
  }
  return url.href
}

export function officialHlsUrl(raw) {
  const url = new URL(officialAssetUrl(raw))
  if (!/^\/live\/[a-z0-9_-]+\.m3u8$/i.test(url.pathname)) {
    throw new Error('甘肃广电返回的不是有效 HLS 入口')
  }
  return url.href
}

export function upstreamHeadersFor(raw) {
  officialAssetUrl(raw)
  return {
    Origin: 'https://www.gstv.com.cn',
    Referer: 'https://www.gstv.com.cn/',
  }
}

function parsePayload(payload) {
  if (typeof payload !== 'string') return payload
  try {
    return JSON.parse(payload)
  } catch {
    throw new Error('甘肃频道接口没有返回有效 JSON')
  }
}

/** 严格验证每一路；单路异常会被隔离，不影响其余健康频道。 */
export function parseChannelList(payload) {
  const response = parsePayload(payload)
  if (String(response?.code) !== '200' || response?.success === false || !Array.isArray(response?.data)) {
    throw new Error('甘肃频道接口返回异常')
  }
  const urls = new Map()
  for (const channel of CHANNELS) {
    const matches = response.data.filter(item => String(item?.id) === channel.channelId)
    if (matches.length !== 1) continue
    const item = matches[0]
    if (Number(item?.type) !== 1 || Number(item?.shelfStatus) !== 1
        || String(item?.liveTitle || '').trim() !== channel.rawName || typeof item?.liveUrl !== 'string') {
      continue
    }
    try {
      urls.set(channel.ref, officialHlsUrl(item.liveUrl))
    } catch {}
  }
  return urls
}

async function discardResponse(response) {
  response.body?.destroy?.()
  await response.body?.cancel?.().catch(() => {})
}

async function responseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredHeader = response.headers?.get?.('content-length')
  const declared = declaredHeader == null ? NaN : Number(declaredHeader)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardResponse(response)
    throw new Error('甘肃广电上游响应过大')
  }
  if (!response.body) return ''
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      response.body?.destroy?.()
      throw new Error('甘肃广电上游响应过大')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export async function requestChannelUrls({
  timeoutMs = 15000,
  fetchImpl = proxyAwareFetch,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(GANSU_CHANNEL_API, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: 'https://www.gstv.com.cn',
        Referer: 'https://www.gstv.com.cn/',
      },
      body: JSON.stringify({ type: 1 }),
    })
    if (REDIRECT_STATUSES.has(response.status)) {
      await discardResponse(response)
      throw new Error('甘肃频道接口返回了不安全的重定向')
    }
    const text = await responseText(response, 512 * 1024)
    if (!response.ok) throw new Error(`甘肃频道接口 HTTP ${response.status}`)
    const urls = parseChannelList(text)
    if (!urls.size) throw new Error('甘肃广电当前没有返回任何有效直播地址')
    return urls
  } finally {
    clearTimeout(timer)
  }
}

function hlsRefs(text, baseUrl) {
  const refs = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    if (value.startsWith('#')) {
      for (const match of value.matchAll(/URI="([^"]+)"/g)) {
        refs.push(new URL(match[1], baseUrl).href)
      }
    } else {
      refs.push(new URL(value, baseUrl).href)
    }
  }
  return refs
}

export function validateHls(text, baseUrl) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('甘肃广电上游不是 HLS 清单')
  }
  for (const ref of hlsRefs(text, baseUrl)) officialAssetUrl(ref)
  return text
}

async function requestManifest(raw, {
  timeoutMs = 15000,
  fetchImpl = proxyAwareFetch,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let url = officialHlsUrl(raw)
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': UA, ...upstreamHeadersFor(url) },
      })
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        await discardResponse(response)
        if (!location) throw new Error('甘肃直播清单重定向缺少地址')
        url = officialHlsUrl(new URL(location, url).href)
        continue
      }
      if (!response.ok) {
        await discardResponse(response)
        throw new Error(`甘肃直播清单 HTTP ${response.status}`)
      }
      const text = await responseText(response)
      validateHls(text, url)
      return { text, url }
    }
    throw new Error('甘肃直播清单重定向次数过多')
  } finally {
    clearTimeout(timer)
  }
}

function snapshot(cache) {
  return new Map([...cache.entries].map(([ref, entry]) => [ref, entry.url]))
}

function pruneExpired(cache, now) {
  for (const [ref, entry] of cache.entries) {
    if (entry.hardExpiresAt <= now) cache.entries.delete(ref)
  }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch } = {}) {
  const caches = new Map()
  const pending = new Map()
  let generation = 0

  async function cachedChannelUrls(options) {
    const fetchImpl = options.fetchImpl || defaultFetch
    const now = Number(options.now ?? Date.now())
    let cached = caches.get(fetchImpl)
    if (cached) pruneExpired(cached, now)
    if (cached?.entries.size && (cached.refreshAt > now || cached.retryAt > now)) {
      return snapshot(cached)
    }

    let active = pending.get(fetchImpl)
    if (!active) {
      const requestGeneration = generation
      const promise = requestChannelUrls({ ...options, fetchImpl }).then(freshUrls => {
        const cachedAt = Number(options.now ?? Date.now())
        const previous = requestGeneration === generation ? caches.get(fetchImpl) : null
        if (previous) pruneExpired(previous, cachedAt)
        const entries = new Map([...freshUrls].map(([ref, url]) => [
          ref,
          { url, hardExpiresAt: cachedAt + CHANNEL_LIST_HARD_TTL_MS },
        ]))
        for (const [ref, entry] of previous?.entries || []) {
          if (!entries.has(ref)) entries.set(ref, entry)
        }
        const next = { entries, refreshAt: cachedAt + CHANNEL_LIST_TTL_MS, retryAt: 0 }
        if (requestGeneration === generation) caches.set(fetchImpl, next)
        return snapshot(next)
      }).finally(() => {
        if (pending.get(fetchImpl)?.promise === promise) pending.delete(fetchImpl)
      })
      active = { promise, generation: requestGeneration }
      pending.set(fetchImpl, active)
    }

    try {
      return await active.promise
    } catch (error) {
      if (active.generation !== generation) throw error
      const failedAt = Number(options.now ?? Date.now())
      cached = caches.get(fetchImpl)
      if (cached) pruneExpired(cached, failedAt)
      if (cached?.entries.size) {
        cached.retryAt = failedAt + CHANNEL_LIST_RETRY_MS
        return snapshot(cached)
      }
      throw error
    }
  }

  function invalidateChannelUrl(channel, failedUrl, fetchImpl) {
    const cached = caches.get(fetchImpl)
    if (cached?.entries.get(channel.ref)?.url === failedUrl) cached.refreshAt = 0
  }

  async function streamUrlFor(channel, options) {
    const url = (await cachedChannelUrls(options)).get(channel.ref)
    if (!url) throw new Error(`${channel.name} 当前不在官网有效直播列表中`)
    return url
  }

  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: '甘肃频道引用格式错误' }
    const options = {
      fetchImpl: ctx.fetchImpl || defaultFetch,
      timeoutMs: ctx.timeoutMs || 15000,
      now: ctx.now,
    }
    try {
      let streamUrl = await streamUrlFor(channel, options)
      let manifest
      try {
        manifest = await requestManifest(streamUrl, options)
      } catch {
        // 官网若轮换不透明的入口文件名，立即重读频道表；保留 API 故障退避。
        invalidateChannelUrl(channel, streamUrl, options.fetchImpl)
        streamUrl = await streamUrlFor(channel, options)
        manifest = await requestManifest(streamUrl, options)
      }
      return {
        url: manifest.url,
        desc: `${channel.name} 官方直播地址获取成功`,
        relayHls: true,
        manifestText: manifest.text,
        manifestUrl: manifest.url,
        upstreamHeaders: upstreamHeadersFor,
        upstreamUrlTransform: officialAssetUrl,
      }
    } catch (error) {
      const reason = error?.name === 'AbortError'
        ? `超时 ${options.timeoutMs}ms`
        : (error?.message || String(error))
      return { url: '', desc: `甘肃广电链接请求失败：${reason}` }
    }
  }

  function clear() {
    generation++
    caches.clear()
    pending.clear()
  }

  return { resolve, clear }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
