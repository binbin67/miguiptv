#!/usr/bin/env node

import { access, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectDir = dirname(scriptDir)
const sourceFile = join(projectDir, 'assets', 'announcement-source.html')
const videoFile = join(projectDir, 'assets', 'announcement.mp4')
const logoFile = join(projectDir, 'assets', 'announcement-logo.png')
const renderDir = await mkdtemp(join(tmpdir(), 'iptv-announcement-'))

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

let browser

try {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--disable-gpu', '--font-render-hinting=none'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })

  for (let slide = 0; slide < 3; slide += 1) {
    const url = new URL(pathToFileURL(sourceFile))
    url.searchParams.set('slide', String(slide))
    await page.goto(url.href, { waitUntil: 'networkidle0' })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: join(renderDir, `slide-${slide}.png`),
      clip: { x: 0, y: 0, width: 1920, height: 1080 },
    })
  }

  await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 })
  const logoUrl = new URL(pathToFileURL(sourceFile))
  logoUrl.searchParams.set('mode', 'logo')
  await page.goto(logoUrl.href, { waitUntil: 'networkidle0' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({
    path: join(renderDir, 'announcement-logo.png'),
    clip: { x: 0, y: 0, width: 512, height: 512 },
  })

  const ffmpeg = await resolveFfmpeg()
  const renderedVideo = join(renderDir, 'announcement.mp4')
  const slideDuration = '5.5'
  const fadeDuration = '0.5'

  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-loop', '1', '-framerate', '25', '-t', slideDuration, '-i', join(renderDir, 'slide-0.png'),
    '-loop', '1', '-framerate', '25', '-t', slideDuration, '-i', join(renderDir, 'slide-1.png'),
    '-loop', '1', '-framerate', '25', '-t', slideDuration, '-i', join(renderDir, 'slide-2.png'),
    '-filter_complex',
    '[0:v]format=yuv420p,setsar=1[v0];' +
    '[1:v]format=yuv420p,setsar=1[v1];' +
    '[2:v]format=yuv420p,setsar=1[v2];' +
    `[v0][v1]xfade=transition=fade:duration=${fadeDuration}:offset=5[x1];` +
    `[x1][v2]xfade=transition=fade:duration=${fadeDuration}:offset=10[v]`,
    '-map', '[v]', '-t', '15.5',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
    '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-metadata', 'title=欢迎使用 iPTV for iFansClub.com',
    '-movflags', '+faststart', '-an', renderedVideo,
  ])

  await copyFile(renderedVideo, videoFile)
  await copyFile(join(renderDir, 'announcement-logo.png'), logoFile)
  console.log(`Generated ${videoFile}`)
  console.log(`Generated ${logoFile}`)
} finally {
  if (browser) await browser.close()
  await rm(renderDir, { recursive: true, force: true })
}
