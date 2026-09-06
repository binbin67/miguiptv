import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { closeBrowser, launchBrowser } from '../../utils/browserLauncher.js'
import { dataPath } from '../../utils/paths.js'

export const YSP_HOME = 'https://www.yangshipin.cn/tv/home'
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DEFAULT_PROFILE = dataPath('yangshipin/chrome-profile')
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const firstLine = error => String(error?.message || error || '未知错误').split('\n')[0]

/** 可见登录窗只能出现在运行服务的桌面会话中；远端后台不能把窗口“传送”到客户端。 */
export function browserLoginAvailability({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin' || platform === 'win32') return { available: true, reason: '' }
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY || env.YSP_ALLOW_HEADFUL === '1')) {
    return { available: true, reason: '' }
  }
  return {
    available: false,
    reason: '当前服务没有可用的桌面显示环境；自动弹窗登录仅支持在服务所在电脑本机运行，Docker/NAS 暂不支持。',
  }
}

export class LoginRequiredError extends Error {
  constructor(message = '央视频登录态不存在或已过期，请先在服务所在电脑本机完成登录') {
    super(message)
    this.name = 'LoginRequiredError'
  }
}

/**
 * 央视频账号级浏览器会话。专用 profile 放在 data 目录，重启后继续由官网 SDK
 * 刷新短效登录材料；profile 本身等同凭据，不进入 JSON 配置或配置备份。
 */
export class YspBrowserSession {
  constructor({
    profileDir = process.env.YSP_PROFILE_DIR || DEFAULT_PROFILE,
    launchImpl = launchBrowser,
    closeImpl = closeBrowser,
    logger = () => {},
  } = {}) {
    this.profileDir = resolve(profileDir)
    this.launchImpl = launchImpl
    this.closeImpl = closeImpl
    this.logger = logger
    this.browser = null
    this.page = null
    this.visible = false
    this.account = null
    this.lifecycle = Promise.resolve()
    this.lifecycleJobs = 0
    this.accountReads = 0
    this.canYield = () => false
  }

  get running() { return Boolean(this.browser?.connected) }

  withLifecycle(work) {
    this.lifecycleJobs++
    const job = this.lifecycle.then(work).finally(() => { this.lifecycleJobs-- })
    this.lifecycle = job.catch(() => {})
    return job
  }

  ensureBrowser(options = {}) {
    return this.withLifecycle(() => this.ensureBrowserNow(options))
  }

  async requestIdleYield() {
    if (this.lifecycleJobs > 0 || this.accountReads > 0 || !this.running || this.visible || !this.canYield()) return false
    await this.close()
    return true
  }

  async ensureBrowserNow({ visible = false } = {}) {
    if (this.running && (!visible || this.visible)) return this.page
    if (this.running) await this.closeNow()

    await mkdir(this.profileDir, { recursive: true })
    this.logger(`启动${visible ? '可见' : '后台'}央视频浏览器会话`)
    const browser = await this.launchImpl({
      headless: !visible,
      label: '央视频会员会话',
      onIdleRequest: () => this.requestIdleYield(),
      launchOptions: {
        userDataDir: this.profileDir,
        protocolTimeout: 30_000,
        defaultViewport: visible ? null : { width: 1440, height: 900 },
      },
    })
    this.browser = browser
    this.visible = visible
    browser.once?.('disconnected', () => {
      if (this.browser !== browser) return
      this.browser = null
      this.page = null
      this.visible = false
      this.account = null
    })

    try {
      const pages = await browser.pages()
      this.page = pages[0] || await browser.newPage()
      await this.configurePage(this.page)
      await this.ensureHome()
      return this.page
    } catch (error) {
      await this.closeNow()
      throw error
    }
  }

  async configurePage(page) {
    await page.setUserAgent(BROWSER_UA)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}))
    await page.setRequestInterception(true)
    page.on('request', request => {
      const url = request.url()
      const type = request.resourceType()
      // 账号页只运行 SDK，不需要持续下载/解码默认频道；真正媒体由 VIP bridge 页面处理。
      if (type === 'media' || /\.(?:ts|m4s|mp4|aac)(?:[?#]|$)/i.test(url)) request.abort().catch(() => {})
      else request.continue().catch(() => {})
    })
  }

  async ensureHome() {
    const page = this.page
    if (!page || page.isClosed()) throw new Error('央视频浏览器页面不可用')
    if (!page.url().startsWith(YSP_HOME)) {
      await page.goto(YSP_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }
    await page.waitForFunction(
      () => window.yspLogin?.default && document.querySelectorAll('.tv-main-con-r-list-left-imga').length >= 40,
      { timeout: 30_000 },
    )
  }

  async readAccount() {
    this.accountReads++
    try { return await this.readAccountNow() }
    finally { this.accountReads-- }
  }

  async readAccountNow() {
    if (!this.running || !this.page || this.page.isClosed()) {
      return { running: false, visible: false, authenticated: false, account: null }
    }
    try {
      const cookies = await this.page.cookies('https://www.yangshipin.cn')
      const hasLoginCookie = cookies.some(cookie => ['ysp_openid', 'yspopenid', 'vusession'].includes(cookie.name) && cookie.value)
      if (!hasLoginCookie) {
        this.account = null
        return { running: true, visible: this.visible, authenticated: false, account: null }
      }
      const account = await this.page.evaluate(async () => {
        const sdk = window.yspLogin?.default
        if (!sdk) return null
        const info = await sdk.info()
        if (!info) return null
        return {
          nickname: String(info.nickname || info.nick || ''),
          type: String(info.type || ''),
          vip: [true, 1, '1', 'true'].includes(info.isVip ?? info.vip ?? info.vip_status),
        }
      })
      this.account = account
      return { running: true, visible: this.visible, authenticated: Boolean(account), account }
    } catch (error) {
      this.account = null
      this.logger(`读取央视频登录态失败：${firstLine(error)}`)
      return { running: this.running, visible: this.visible, authenticated: false, account: null }
    }
  }

  async openLogin() {
    return this.withLifecycle(async () => {
      const page = await this.ensureBrowserNow({ visible: true })
      await page.bringToFront()
      const status = await this.readAccount()
      if (!status.authenticated) {
        await page.evaluate(() => window.yspLogin.default.signin({ mobile: true, wechat: true, qq: false, weibo: false }))
      }
      return status
    })
  }

  close() {
    return this.withLifecycle(() => this.closeNow())
  }

  async closeNow() {
    const browser = this.browser
    this.browser = null
    this.page = null
    this.visible = false
    this.account = null
    if (!browser) return
    await this.closeImpl(browser, { label: '央视频会员会话' })
  }
}

const LOGIN_ACTIVE = new Set(['opening', 'waiting', 'restoring'])

/** 单路登录状态机：自动识别官网登录，关闭可见窗口，再以同一 profile 切回后台。 */
export class YspBrowserLogin {
  constructor(browserSession, {
    beforeOpen = async () => {},
    restore = async () => {},
    pollMs = 2_000,
    timeoutMs = 6 * 60_000,
    sleepImpl = sleep,
  } = {}) {
    this.browserSession = browserSession
    this.beforeOpen = beforeOpen
    this.restore = restore
    this.pollMs = pollMs
    this.timeoutMs = timeoutMs
    this.sleep = sleepImpl
    this.runId = 0
    this.task = null
    this.restoreTask = null
    this.lastVerifiedAt = null
    this.state = { status: 'idle', message: '尚未检查央视频登录态', account: null }
  }

  status() {
    return {
      ...this.state,
      account: this.state.account ? { ...this.state.account } : null,
      active: LOGIN_ACTIVE.has(this.state.status),
      lastVerifiedAt: this.lastVerifiedAt,
    }
  }

  active() { return LOGIN_ACTIVE.has(this.state.status) }

  noteAccount(status) {
    if (this.active()) return this.status()
    this.lastVerifiedAt = Date.now()
    if (status.authenticated) {
      const vipMessage = status.account?.vip ? 'VIP 权益已识别' : '未识别到有效 VIP 权益'
      this.state = { status: 'success', message: `已关联央视频账号，${vipMessage}`, account: status.account }
    } else {
      this.state = { status: 'idle', message: '尚未检测到有效央视频登录态', account: null }
    }
    return this.status()
  }

  start() {
    if (this.active()) return this.status()
    const runId = ++this.runId
    this.state = { status: 'opening', message: '正在打开央视频官方登录窗口…', account: null }
    const task = this.run(runId)
    this.task = task
    task.finally(() => { if (this.task === task) this.task = null })
    return this.status()
  }

  async cancel({ restore = true } = {}) {
    const runningTask = this.task
    const shouldRestore = this.active() || this.browserSession.visible
    ++this.runId
    this.state = restore && shouldRestore
      ? { status: 'restoring', message: '正在取消登录并恢复后台会话…', account: null }
      : { status: 'idle', message: '已取消央视频登录关联', account: null }
    if (restore && shouldRestore) {
      try {
        await this.restoreBackground()
        if (runningTask) await runningTask
        this.state = { status: 'idle', message: '已取消登录，后台会话已恢复', account: null }
      } catch (error) {
        this.state = { status: 'error', message: `取消登录后恢复后台会话失败：${firstLine(error)}`, account: null }
      }
    }
    if (!restore && runningTask) await runningTask
    return this.status()
  }

  async restoreBackground() {
    if (this.restoreTask) return this.restoreTask
    const task = (async () => {
      await this.browserSession.close()
      await this.restore()
    })()
    this.restoreTask = task
    try { await task }
    finally { if (this.restoreTask === task) this.restoreTask = null }
  }

  async finish(status, runId) {
    if (runId !== this.runId) return
    this.state = { status: 'restoring', message: '已识别登录，正在切回后台播放会话…', account: status.account }
    await this.restoreBackground()
    if (runId !== this.runId) return
    const confirmed = await this.browserSession.readAccount()
    if (runId !== this.runId) return
    if (!confirmed.authenticated) throw new LoginRequiredError('登录已识别，但切回后台后未能恢复央视频会话')
    const vipMessage = confirmed.account?.vip ? 'VIP 权益已识别' : '未识别到有效 VIP 权益'
    this.state = {
      status: 'success',
      message: `央视频账号已自动关联，${vipMessage}；官方窗口已关闭`,
      account: confirmed.account,
    }
    this.lastVerifiedAt = Date.now()
  }

  async run(runId) {
    let prepared = false
    try {
      const existing = await this.browserSession.readAccount()
      if (runId !== this.runId) return
      if (existing.authenticated) {
        const vipMessage = existing.account?.vip ? 'VIP 权益已识别' : '未识别到有效 VIP 权益'
        this.state = { status: 'success', message: `已关联现有央视频账号，${vipMessage}`, account: existing.account }
        this.lastVerifiedAt = Date.now()
        return
      }

      prepared = true
      await this.beforeOpen()
      if (runId !== this.runId) return
      const opened = await this.browserSession.openLogin()
      if (runId !== this.runId) return
      if (opened.authenticated) return this.finish(opened, runId)

      this.state = {
        status: 'waiting',
        message: '请在弹出的央视频官方页面完成登录；成功后会自动识别并关闭窗口',
        account: null,
      }
      const deadline = Date.now() + this.timeoutMs
      while (Date.now() < deadline && runId === this.runId) {
        await this.sleep(this.pollMs)
        if (runId !== this.runId) return
        const status = await this.browserSession.readAccount()
        if (runId !== this.runId) return
        if (status.authenticated) return this.finish(status, runId)
        if (!status.running) throw new Error('央视频登录窗口已关闭，请重试')
      }
      if (runId === this.runId) throw new Error('等待央视频官网登录超时，请重新打开登录窗口')
    } catch (error) {
      if (runId !== this.runId) return
      let reason = firstLine(error)
      if (prepared) {
        this.state = { status: 'restoring', message: '登录未完成，正在恢复后台会话…', account: null }
        try { await this.restoreBackground() }
        catch (restoreError) { reason += `；恢复后台会话失败：${firstLine(restoreError)}` }
      }
      if (runId === this.runId) this.state = { status: 'error', message: reason, account: null }
    }
  }
}
