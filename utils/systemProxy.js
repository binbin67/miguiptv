import { execFileSync } from 'node:child_process'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

let detected = false
let proxyUrl = ''
let dispatcher

function macosHttpsProxy() {
  if (process.platform !== 'darwin') return ''
  try {
    const output = execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!/^\s*HTTPSEnable\s*:\s*1\s*$/m.test(output)) return ''
    const host = output.match(/^\s*HTTPSProxy\s*:\s*(\S+)\s*$/m)?.[1]
    const port = output.match(/^\s*HTTPSPort\s*:\s*(\d+)\s*$/m)?.[1]
    return host && port ? `http://${host}:${port}` : ''
  } catch {
    return ''
  }
}

/**
 * Node 的 fetch 默认既不读取 HTTPS_PROXY，也不跟随 macOS 系统代理。浏览器能播、
 * 服务端却被境外 CDN 拒绝时就会出现这种差异。只给需要它的上游请求补这层代理；Linux
 * / Docker 没配代理时返回 undefined，保持原有直连行为。
 */
export function systemProxyDispatcher() {
  if (!detected) {
    detected = true
    proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || macosHttpsProxy()
    if (proxyUrl) dispatcher = new ProxyAgent(proxyUrl)
  }
  return dispatcher
}

export function systemProxyUrl() {
  systemProxyDispatcher()
  return proxyUrl
}

function isLoopback(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** 与 ProxyAgent 来自同一 undici 版本，避免不同 Node 版本内置 fetch 的协议不兼容。 */
export function proxyAwareFetch(url, options = {}) {
  const dispatcher = isLoopback(url) ? undefined : systemProxyDispatcher()
  return undiciFetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) })
}
