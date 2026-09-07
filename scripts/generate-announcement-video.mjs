#!/usr/bin/env node

/**
 * 系统频道短片生成器：把 assets/<name>-source.html 的各页截成 1080p 帧，
 * 用 ffmpeg 淡入淡出串成 mp4，并顺手截一张 512×512 台标。
 *
 * 用法：
 *   node scripts/generate-announcement-video.mjs                 # 只生成公告短片（默认）
 *   node scripts/generate-announcement-video.mjs ysp-login-guide # 只生成央视频登录教程
 *   node scripts/generate-announcement-video.mjs from-the-web-guide # 只生成「来源于网络」添加教程
 *   node scripts/generate-announcement-video.mjs all             # 全部
 *   node scripts/generate-announcement-video.mjs <name> --frames <dir>   # 额外把每页 PNG 留到目录里，方便看版式
 *
 * 每页 5.5 秒、页间 0.5 秒淡入淡出，总时长 = 5 × 页数 + 0.5 秒。
 */

import { access, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectDir = dirname(scriptDir)
const assetsDir = join(projectDir, 'assets')

const TARGETS = {
  announcement: {
    source: 'announcement-source.html',
    video: 'announcement.mp4',
    logo: 'announcement-logo.png',
    slides: 3,
    title: '欢迎使用 iPTV for iFansClub.com',
  },
  'ysp-login-guide': {
    source: 'ysp-login-guide-source.html',
    video: 'ysp-login-guide.mp4',
    logo: 'ysp-login-guide-logo.png',
    slides: 6,
    title: '央视频会员频道：把登录态导入 iPTV',
  },
  'from-the-web-guide': {
    source: 'from-the-web-guide-source.html',
    video: 'from-the-web-guide.mp4',
    logo: 'from-the-web-guide-logo.png',
    slides: 5,
    title: '来源于网络的频道：把 from-the-web.m3u 加进 iPTV',
  },
}

const SLIDE_SECONDS = 5.5
const FADE_SECONDS = 0.5

const args = process.argv.slice(2)
const framesIndex = args.indexOf('--frames')
const framesDir = framesIndex !== -1 ? resolve(args[framesIndex + 1] || 'frames') : null
const names = args.filter((value, index) => !value.startsWith('--') && index !== framesIndex + 1)
const selected = names.length === 0 ? ['announcement'] : names.includes('all') ? Object.keys(TARGETS) : names
for (const name of selected) {
  if (!TARGETS[name]) {
    console.error(`未知目标 ${name}；可用：${Object.keys(TARGETS).join(', ')}, all`)
    process.exit(1)
  }
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/Applications/iSave.app/Contents/Resources/ffmpeg',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }

  return 'ffmpeg'
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}`)))
  })
}

async function renderTarget(browser, ffmpeg, name, target, renderDir) {
  const sourceFile = join(assetsDir, target.source)
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })

  const slidePaths = []
  for (let slide = 0; slide < target.slides; slide += 1) {
    const url = new URL(pathToFileURL(sourceFile))
    url.searchParams.set('slide', String(slide))
    await page.goto(url.href, { waitUntil: 'networkidle0' })
    await page.evaluate(() => document.fonts.ready)
    const path = join(renderDir, `${name}-slide-${slide}.png`)
    await page.screenshot({ path, clip: { x: 0, y: 0, width: 1920, height: 1080 } })
    slidePaths.push(path)
  }

  await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 })
  const logoUrl = new URL(pathToFileURL(sourceFile))
  logoUrl.searchParams.set('mode', 'logo')
  await page.goto(logoUrl.href, { waitUntil: 'networkidle0' })
  await page.evaluate(() => document.fonts.ready)
  const logoPath = join(renderDir, target.logo)
  await page.screenshot({ path: logoPath, clip: { x: 0, y: 0, width: 512, height: 512 } })
  await page.close()

  if (framesDir) {
    await mkdir(framesDir, { recursive: true })
    for (const path of [...slidePaths, logoPath]) await copyFile(path, join(framesDir, path.split('/').pop()))
  }

  // 输入：每页循环成 5.5 秒的静态视频；滤镜：逐页 xfade，第 k 次过渡的 offset = 5k 秒
  const inputs = slidePaths.flatMap(path => ['-loop', '1', '-framerate', '25', '-t', String(SLIDE_SECONDS), '-i', path])
  const filters = slidePaths.map((_, index) => `[${index}:v]format=yuv420p,setsar=1[v${index}]`)
  let last = 'v0'
  for (let index = 1; index < slidePaths.length; index += 1) {
    const out = index === slidePaths.length - 1 ? 'v' : `x${index}`
    filters.push(`[${last}][v${index}]xfade=transition=fade:duration=${FADE_SECONDS}:offset=${(SLIDE_SECONDS - FADE_SECONDS) * index}[${out}]`)
    last = out
  }
  if (slidePaths.length === 1) filters.push('[v0]copy[v]')
  const totalSeconds = (SLIDE_SECONDS - FADE_SECONDS) * slidePaths.length + FADE_SECONDS

  const renderedVideo = join(renderDir, target.video)
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'warning', '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-t', String(totalSeconds),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
    '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-metadata', `title=${target.title}`,
    '-movflags', '+faststart', '-an', renderedVideo,
  ])

  await copyFile(renderedVideo, join(assetsDir, target.video))
  await copyFile(logoPath, join(assetsDir, target.logo))
  console.log(`Generated ${join(assetsDir, target.video)} (${totalSeconds}s, ${slidePaths.length} slides)`)
  console.log(`Generated ${join(assetsDir, target.logo)}`)
}

const renderDir = await mkdtemp(join(tmpdir(), 'iptv-system-video-'))
let browser

try {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--disable-gpu', '--font-render-hinting=none'],
  })
  const ffmpeg = await resolveFfmpeg()
  for (const name of selected) await renderTarget(browser, ffmpeg, name, TARGETS[name], renderDir)
} finally {
  if (browser) await browser.close()
  await rm(renderDir, { recursive: true, force: true })
}
