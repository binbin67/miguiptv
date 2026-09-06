import { printBlue, printRed, printYellow } from '../../utils/colorOut.js'
import { AUTH_CHANNEL_BY_ID, AUTH_CHANNEL_BY_REF } from './channels.js'
import {
  browserLoginAvailability,
  LoginRequiredError,
  YspBrowserLogin,
  YspBrowserSession,
} from './browser-auth.js'
import { VipMseBridge } from './vip-bridge.js'

const firstLine = error => String(error?.message || error || '未知错误').split('\n')[0]
const log = message => printBlue(`[央视频] ${message}`)
const ACCOUNT_STATUS_TTL = 5 * 60_000

const browserSession = new YspBrowserSession({ logger: log })
const vipBridge = new VipMseBridge(browserSession, { logger: log })
const browserLogin = new YspBrowserLogin(browserSession, {
  beforeOpen: async () => {
    await vipBridge.suspend()
  },
  restore: async () => {
    await vipBridge.resume()
    // finish() 紧接着会读 SDK 再确认一次；这里必须先用同一 profile 恢复后台页。
    await browserSession.ensureBrowser({ visible: false })
  },
})

browserSession.canYield = () => vipBridge.isIdle() && !browserLogin.active()

function statusSnapshot() {
  const state = browserLogin.status()
  // 浏览器运行时只信刚从当前页面验证过的 session.account；关闭后可短暂展示上次
  // 已确认结果，但不永久把旧昵称/VIP 标成有效。详情页会主动 check() 刷新。
  const cachedAccountFresh = state.account && state.lastVerifiedAt
    && Date.now() - state.lastVerifiedAt < ACCOUNT_STATUS_TTL
  const account = browserSession.running
    ? browserSession.account
    : (cachedAccountFresh ? state.account : null)
  const snapshot = {
    ...state,
    ...browserLoginAvailability(),
    running: browserSession.running,
    visible: browserSession.visible,
    authenticated: Boolean(account),
    account: account ? { ...account } : null,
  }
  if (!snapshot.active && state.account && !account) {
    snapshot.status = 'idle'
    snapshot.message = '央视频登录态需要重新检查'
  }
  return snapshot
}

export const browserLoginFlow = {
  status() {
    return statusSnapshot()
  },

  start() {
    const availability = browserLoginAvailability()
    if (!availability.available) throw new Error(availability.reason)
    browserLogin.start()
    return statusSnapshot()
  },

  async check() {
    if (browserLogin.active()) return statusSnapshot()
    vipBridge.lastActivity = Date.now()
    await browserSession.ensureBrowser({ visible: false })
    const account = await browserSession.readAccount()
    vipBridge.lastActivity = Date.now()
    browserLogin.noteAccount(account)
    return statusSnapshot()
  },

  async cancel() {
    await browserLogin.cancel()
    return statusSnapshot()
  },

  async close() {
    await browserLogin.cancel({ restore: false })
    await vipBridge.suspend()
    await browserSession.close()
    await vipBridge.resume()
    browserLogin.noteAccount({ authenticated: false, account: null })
    return statusSnapshot()
  },
}

function isTopLevelRef(path) {
  const ref = String(path || '').split('/').filter(Boolean).at(-1) || ''
  return AUTH_CHANNEL_BY_REF.has(ref) ? ref : ''
}

export function claimsLocalPath(path) {
  const value = String(path || '')
  return value.startsWith('/ysp-vip/') || Boolean(isTopLevelRef(value))
}

function response(status, contentType, body = '', headers = {}) {
  const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body))
  return {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store',
      ...(length ? { 'Content-Length': length } : {}),
      ...headers,
    },
    body,
  }
}

function rangeResponse(body, rangeHeader) {
  const total = body.length
  const baseHeaders = { 'Accept-Ranges': 'bytes' }
  if (!rangeHeader) return response(200, 'video/mp4', body, baseHeaders)
  const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return response(416, 'video/mp4', '', { ...baseHeaders, 'Content-Range': `bytes */${total}` })
  let start = 0
  let end = total - 1
  if (!match[1] && match[2]) start = Math.max(0, total - Number(match[2]))
  else {
    start = Number(match[1] || 0)
    if (match[2]) end = Number(match[2])
  }
  end = Math.min(end, total - 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= total) {
    return response(416, 'video/mp4', '', { ...baseHeaders, 'Content-Range': `bytes */${total}` })
  }
  const part = body.subarray(start, end + 1)
  return response(206, 'video/mp4', part, {
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${total}`,
  })
}

/** 模块本地媒体路由；app.js 只负责鉴权、选择模块及写 HTTP 响应。 */
export async function handleLocalRequest({ path, method = 'GET', headers = {}, accessPrefix = '' } = {}) {
  const value = String(path || '')
  const playlistMatch = value.match(/^\/ysp-vip\/([a-z0-9]+)\/(video|audio)\.m3u8$/i)
  const assetMatch = value.match(/^\/ysp-vip\/([a-z0-9]+)\/(video|audio)\/(init|\d+)\.(?:mp4|m4s)$/i)
  const topRef = isTopLevelRef(value)
  const channel = topRef
    ? AUTH_CHANNEL_BY_REF.get(topRef)
    : AUTH_CHANNEL_BY_ID.get(playlistMatch?.[1] || assetMatch?.[1] || '')

  if (!channel) return response(404, 'text/plain;charset=UTF-8', '没有这个央视频会员频道')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return response(405, 'text/plain;charset=UTF-8', '只支持 GET/HEAD', { Allow: 'GET, HEAD, OPTIONS' })
  }
  if (method === 'OPTIONS') {
    return response(200, playlistMatch || topRef ? 'application/vnd.apple.mpegurl' : 'video/mp4')
  }
  if (method === 'HEAD') {
    if (topRef) {
      const result = response(200, 'application/vnd.apple.mpegurl', vipBridge.master(channel, accessPrefix))
      result.body = ''
      return result
    }
    if (playlistMatch) return response(200, 'application/vnd.apple.mpegurl')
    const body = vipBridge.asset(channel, assetMatch[2].toLowerCase(), assetMatch[3], { touch: false })
    if (!body) return response(404, 'text/plain;charset=UTF-8', '央视频会员片段已过期，请让播放器刷新清单')
    const result = rangeResponse(body, headers.range)
    result.body = ''
    return result
  }
  if (browserLogin.active()) {
    return response(409, 'text/plain;charset=UTF-8', '央视频正在完成登录关联，请稍后重试')
  }

  try {
    if (topRef) {
      return response(200, 'application/vnd.apple.mpegurl', vipBridge.master(channel, accessPrefix))
    }
    if (playlistMatch) {
      const body = await vipBridge.playlist(channel, playlistMatch[2].toLowerCase(), accessPrefix)
      return response(200, 'application/vnd.apple.mpegurl', body)
    }
    const body = vipBridge.asset(channel, assetMatch[2].toLowerCase(), assetMatch[3])
    if (!body) return response(404, 'text/plain;charset=UTF-8', '央视频会员片段已过期，请让播放器刷新清单')
    return rangeResponse(body, headers.range)
  } catch (error) {
    const reason = error?.name === 'AbortError' ? '请求超时' : firstLine(error)
    if (error instanceof LoginRequiredError) printYellow(`[央视频] ${channel.name}：${reason}`)
    else printRed(`[央视频] ${channel.name} 播放失败：${reason}`)
    return response(error instanceof LoginRequiredError ? 401 : 502, 'text/plain;charset=UTF-8', reason)
  }
}

let shuttingDown = null
export function shutdown() {
  if (shuttingDown) return shuttingDown
  shuttingDown = (async () => {
    await browserLogin.cancel({ restore: false })
    await vipBridge.close()
    await browserSession.close()
  })().catch(error => printRed(`[央视频] 关闭浏览器会话失败：${firstLine(error)}`))
  return shuttingDown
}

// 测试只读导出，不在业务层直接操纵这些对象。
export const runtime = { browserSession, vipBridge, browserLogin }
