/** iPanda 动态频道：匿名 liveHtml5 调度、官方 CDN 校验与短期缓存。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { sourceFromRef } from './channels.js'

export const LIVE_API_HOST = 'vdn.live.cntv.cn'
export const DYNAMIC_HOSTS = Object.freeze([
  'gcwbndtxy.liveplay.myqcloud.com',
  'gcwbndali.v.myalicdn.com',
  'gcwbndbd.a.bdydns.com',
  'gcwbndks.v.kcdnvip.com',
  'gcwbndcnc.v.wscdns.com',
])
export const STREAM_TTL_MS = 45 * 1000

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function endpointAllowed(url, rules) {
  return rules.some(host => url.protocol === 'https:' && !url.port && url.hostname === host)
}

export function allowUrl(raw, rules = DYNAMIC_HOSTS) {
  const url = new URL(String(raw || '').trim())
  if (url.username || url.password || !endpointAllowed(url, rules)) {
    throw new Error(`不允许访问媒体地址：${url.protocol}//${url.host}`)
  }
  return url.href
}

async function discard(response) {
  response.body?.destroy?.()
  await response.body?.cancel?.().catch(() => {})
}

function withTimeout(timeoutMs, externalSignal) {
  const controller = new AbortController()
  const abortExternal = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) abortExternal()
  else externalSignal?.addEventListener('abort', abortExternal, { once: true })
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15_000))
  return {
    signal: controller.signal,
    abort(reason) {
      controller.abort(reason)
    },
    done() {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', abortExternal)
    },
  }
}

export async function fetchText(raw, {
  rules = DYNAMIC_HOSTS,
  fetchImpl = proxyAwareFetch,
  timeoutMs = 15_000,
  headers = {},
  signal,
} = {}) {
  let url = allowUrl(raw, rules)
  const timeout = withTimeout(timeoutMs, signal)
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: timeout.signal,
        headers: { 'User-Agent': UA, ...headers },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await discard(response)
        if (!location) throw new Error('上游重定向缺少地址')
        url = allowUrl(new URL(location, url).href, rules)
        continue
      }
      if (!response.ok) {
        await discard(response)
        throw new Error(`${new URL(url).hostname} HTTP ${response.status}`)
      }
      const text = await response.text()
      if (text.length > 2 * 1024 * 1024) throw new Error('上游响应过大')
      return { text, url: response.url || url, headers: response.headers }
    }
    throw new Error('上游重定向次数过多')
  } finally {
    timeout.done()
  }
}

function hlsRefs(text, base) {
  const refs = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    if (value.startsWith('#')) {
      for (const match of value.matchAll(/URI="([^"]+)"/g)) refs.push(new URL(match[1], base).href)
    } else {
      refs.push(new URL(value, base).href)
    }
  }
  return refs
}

export function validateHls(text, base, rules = DYNAMIC_HOSTS) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('上游不是 HLS 清单')
  for (const ref of hlsRefs(text, base)) allowUrl(ref, rules)
  return text
}

export function highestVariantUrl(text, base) {
  const lines = text.replace(/\r/g, '').split('\n')
  let best = null
  for (let index = 0; index < lines.length; index++) {
    const tag = lines[index].trim()
    if (!tag.startsWith('#EXT-X-STREAM-INF:')) continue
    let uri = ''
    for (let next = index + 1; next < lines.length; next++) {
      const value = lines[next].trim()
      if (!value) continue
      if (!value.startsWith('#')) uri = value
      break
    }
    if (!uri) continue
    const resolution = tag.match(/\bRESOLUTION=(\d+)x(\d+)/i)
    const bandwidth = Number(tag.match(/\b(?:AVERAGE-)?BANDWIDTH=(\d+)/i)?.[1] || 0)
    const pixels = resolution ? Number(resolution[1]) * Number(resolution[2]) : 0
    if (!best || pixels > best.pixels || (pixels === best.pixels && bandwidth > best.bandwidth)) {
      best = { url: new URL(uri, base).href, pixels, bandwidth }
    }
  }
  return best?.url || ''
}

export function hasMediaSegment(text) {
  const lines = text.replace(/\r/g, '').split('\n')
  let waitingForUri = false
  for (const line of lines) {
    const value = line.trim()
    if (value.startsWith('#EXTINF:')) {
      waitingForUri = true
      continue
    }
    if (waitingForUri && value && !value.startsWith('#')) return true
  }
  return false
}

export function parseLiveApi(text, rules = DYNAMIC_HOSTS) {
  const match = String(text || '').match(/\bhtml5VideoData\s*=\s*'([\s\S]*?)'\s*;\s*getHtml5VideoData/)
  if (!match) throw new Error('央视直播接口返回格式已变化')
  const data = JSON.parse(match[1])
  if (data.ack !== 'yes' || data.status !== '1' || data.play !== '1' || data.public !== '1') {
    throw new Error(data.tip_msg || '频道当前不是匿名公开直播')
  }
  const urls = data.hls_url || {}
  const result = []
  for (const name of ['hls1', 'hls4', 'hls2']) {
    const value = urls[name]
    if (typeof value !== 'string' || !value.startsWith('https://')) continue
    try { result.push(allowUrl(value, rules)) } catch {}
  }
  if (!result.length) throw new Error('央视直播接口未返回可用的 HTTPS HLS')
  return [...new Set(result)]
}

export async function selectDynamicStream(source, options = {}) {
  if (!source?.dynamic || !/^[a-z0-9]+$/i.test(source.channel || '')) {
    throw new Error('iPanda 动态频道定义无效')
  }
  const requestHeaders = { Referer: source.page, Origin: 'https://live.ipanda.com' }
  const timeout = withTimeout(options.timeoutMs || 15_000, options.signal)
  try {
    const endpoint = `https://${LIVE_API_HOST}/api2/liveHtml5.do?channel=pa://cctv_p2p_hd${source.channel}&client=html5`
    const api = await fetchText(endpoint, {
      ...options,
      rules: [LIVE_API_HOST],
      headers: requestHeaders,
      signal: timeout.signal,
    })
    const canonicalAli = `https://gcwbndali.v.myalicdn.com/gcwbnd/${source.channel}_2/index.m3u8`
    const candidates = [...new Set([...parseLiveApi(api.text), canonicalAli])]

    const race = withTimeout(options.timeoutMs || 15_000, timeout.signal)
    try {
      const probes = candidates.map(async candidate => {
        try {
          const master = await fetchText(candidate, {
            ...options,
            rules: DYNAMIC_HOSTS,
            headers: requestHeaders,
            signal: race.signal,
          })
          let current = master
          let topLevelIsMaster = false
          for (let depth = 0; depth < 3; depth++) {
            validateHls(current.text, current.url)
            const highest = highestVariantUrl(current.text, current.url)
            if (depth === 0) topLevelIsMaster = Boolean(highest)
            if (!highest) {
              if (!hasMediaSegment(current.text)) throw new Error('媒体清单没有分片')
              return {
                url: master.url,
                manifestUrl: master.url,
                // master 变化慢且保留完整档位，可以安全复用；若顶层直接是滚动 media，
                // 只缓存 URL，让 app 在播放器每次轮询时重取新分片，避免冻结 45 秒。
                ...(topLevelIsMaster ? { manifestText: master.text } : {}),
              }
            }
            current = await fetchText(highest, {
              ...options,
              rules: DYNAMIC_HOSTS,
              headers: requestHeaders,
              signal: race.signal,
            })
          }
          throw new Error('HLS 主清单嵌套层数过多')
        } catch (error) {
          const reason = error?.name === 'AbortError' ? '超时' : (error?.message || String(error))
          throw new Error(`${new URL(candidate).hostname}: ${reason}`)
        }
      })

      try {
        return await Promise.any(probes)
      } catch (error) {
        const details = Array.isArray(error?.errors)
          ? error.errors.map(item => item?.message || String(item))
          : [error?.message || String(error)]
        throw new Error(`官方动态线路均不可用：${details.join('；')}`)
      }
    } finally {
      race.abort()
      race.done()
    }
  } finally {
    timeout.done()
  }
}

export function createResolver({ fetchImpl = proxyAwareFetch } = {}) {
  const streamCache = new Map()
  const pending = new Map()
  let generation = 0

  async function resolve(ref, ctx = {}) {
    const source = sourceFromRef(ref)
    if (!source) return { url: '', desc: 'iPanda 频道引用格式错误' }
    const request = {
      fetchImpl: ctx.fetchImpl || fetchImpl,
      timeoutMs: ctx.timeoutMs || 15_000,
      now: Number(ctx.now ?? Date.now()),
    }
    try {
      let entry = streamCache.get(source.id)
      if (!entry || entry.expiresAt <= request.now || entry.fetchImpl !== request.fetchImpl) {
        let active = pending.get(source.id)
        if (!active || active.fetchImpl !== request.fetchImpl) {
          const startedInGeneration = generation
          const promise = selectDynamicStream(source, request)
            .then(result => {
              const fresh = {
                ...result,
                expiresAt: request.now + STREAM_TTL_MS,
                fetchImpl: request.fetchImpl,
              }
              if (generation === startedInGeneration) streamCache.set(source.id, fresh)
              return fresh
            })
            .finally(() => {
              if (pending.get(source.id)?.promise === promise) pending.delete(source.id)
            })
          active = { promise, fetchImpl: request.fetchImpl }
          pending.set(source.id, active)
        }
        entry = await active.promise
      }

      const upstreamHeaders = raw => {
        allowUrl(raw, DYNAMIC_HOSTS)
        return { Referer: source.page, Origin: 'https://live.ipanda.com' }
      }
      return {
        url: entry.url,
        manifestText: entry.manifestText,
        manifestUrl: entry.manifestUrl,
        desc: `${source.name} 匿名播放地址获取成功`,
        upstreamHeaders,
        upstreamUrlTransform: raw => allowUrl(raw, DYNAMIC_HOSTS),
      }
    } catch (error) {
      streamCache.delete(source.id)
      const reason = error?.name === 'AbortError'
        ? `超时 ${request.timeoutMs}ms`
        : (error?.message || String(error))
      return { url: '', desc: `${source.name} 链接请求失败：${reason}` }
    }
  }

  function clear() {
    generation++
    streamCache.clear()
    pending.clear()
  }

  return { resolve, clear, streamCache, pending }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
