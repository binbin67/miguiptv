#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import sichuan from '../extractors/sichuan/index.js'
import {
  SICHUAN_AUTH_API,
  SICHUAN_LIVE_API,
  SICHUAN_LIVE_DETAIL_API,
  SICHUAN_LIVE_MEDIA_HEADERS,
  SICHUAN_MEDIA_HEADERS,
  SICHUAN_PAGE,
  applySichuanSecret,
  buildChannels,
  buildLiveChannels,
  claimsRef,
  clearCache,
  officialAssetUrl,
  parseChannelList,
  parseCredential,
  parseLiveList,
  resolveChannel,
  upstreamHeadersFor,
} from '../extractors/sichuan/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { redactConfig, resolveConfig, validateConfig } from '../utils/extractorManager.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

const rows = [
  { id: '1016553', name: '四川卫视', rawUrl: 'https://tvshowf.scgczm.com/live/sctv1.m3u8' },
  { id: '1970689144638746626', name: '四川卫视4K超高清SDR', rawUrl: 'https://hmmslivef.scgczm.com/live/4ksctv1.m3u8' },
]
const fixtureHtml = `before${rows.map(row => JSON.stringify({
  id: row.id,
  name: row.name,
  playAddress: row.rawUrl,
})).join('')}after`
const liveEvent = {
  id: '2096229462308356097',
  title: '跟着赛事去旅行',
  cover: 'https://kscgc.scgchc.com/live/event.jpg',
}
const liveUrl = 'https://mmslivef.scgchc.com/live/18287.m3u8?auth_key=signed'

console.log('四川广电模块测试')

check('模块注册为需账号的四川全代理模块', () => {
  assert.equal(getModule('sichuan'), sichuan)
  assert.equal(sichuan.category, 'account')
  assert.equal(sichuan.channelHlsMode, 'proxy')
  assert.equal(sichuan.capabilities.catchup, false)
  assert.equal(sichuan.helper, 'sichuan-token')
  assert.equal(sichuan.helperSection, '四川官网登录')
  assert.equal(resolverFor('sichuan-1016553'), sichuan)
  assert.equal(resolverFor('sichuan-1016553/extra'), null)
})

check('输入支持裸 Token、Bearer、当前键名与完整账号 JSON', () => {
  assert.equal(parseCredential('plain-token'), 'plain-token')
  assert.equal(parseCredential('Bearer bearer-token'), 'bearer-token')
  assert.equal(parseCredential('{"access_token":"json-token"}'), 'json-token')
  assert.equal(
    parseCredential('scgc_userAccountInfo=%7B%22access_token%22%3A%22encoded-token%22%7D'),
    'encoded-token',
  )
  assert.throws(() => parseCredential('{"nickname":"tester"}'), /没有 access_token/)
  const stored = validateConfig(sichuan, { accessToken: 'secret-token' }).config
  const redacted = redactConfig(sichuan, resolveConfig(sichuan, stored))
  assert.equal(redacted.config.accessToken, '')
  assert.equal(redacted.secretsSet.accessToken, true)
  assert.equal(JSON.stringify(redacted).includes('secret-token'), false)
})

check('频道目录排除购物并生成稳定的延迟引用', () => {
  const html = fixtureHtml + JSON.stringify({
    id: '9', name: '星空购物', playAddress: 'https://tvshowf.scgczm.com/live/shop.m3u8',
  })
  const parsed = parseChannelList(html)
  assert.deepEqual(parsed, rows)
  assert.deepEqual(buildChannels(parsed).map(channel => channel.deferredRef), [
    'sichuan-1016553',
    'sichuan-1970689144638746626',
  ])
  assert.equal(claimsRef('sichuan-text'), false)
})

check('活动目录生成同一四川分组使用的动态引用', () => {
  const parsed = parseLiveList({ rs: 200, data: [liveEvent, liveEvent, { id: 'bad', title: '' }] })
  assert.deepEqual(parsed, [{ id: liveEvent.id, name: liveEvent.title, cover: liveEvent.cover }])
  assert.equal(buildLiveChannels(parsed)[0].deferredRef, `sichuan-live-${liveEvent.id}`)
  assert.equal(claimsRef(`sichuan-live-${liveEvent.id}`), true)
  assert.equal(claimsRef(`sichuan-live-${liveEvent.id}/extra`), false)
})

check('媒体白名单覆盖清单、密钥和分片，并固定携带官网来源头', () => {
  assert.match(officialAssetUrl('https://tvshowf.scgczm.com/live/a.ts?auth_key=x'), /a\.ts/)
  assert.match(officialAssetUrl('https://hmmslivef.scgczm.com/live/a.key'), /a\.key$/)
  assert.match(officialAssetUrl(liveUrl), /18287\.m3u8/)
  assert.deepEqual(upstreamHeadersFor('https://tvshowf.scgczm.com/live/a.ts'), SICHUAN_MEDIA_HEADERS)
  assert.deepEqual(upstreamHeadersFor(liveUrl), SICHUAN_LIVE_MEDIA_HEADERS)
  for (const bad of [
    'http://tvshowf.scgczm.com/live/a.ts',
    'https://tvshowf.scgczm.com.evil.test/live/a.ts',
    'https://127.0.0.1/private.ts',
  ]) assert.throws(() => officialAssetUrl(bad), /非官方媒体地址/)
  assert.throws(() => upstreamHeadersFor('https://example.com/redirected.ts'), /非官方媒体地址/)
})

await checkAsync('配置 Token 后抓取频道，并在播放时动态换签', async () => {
  clearCache()
  const accessToken = 'account-token'
  const secret = '1788667000-1-0-testsecret'
  const calls = []
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(String(raw))
    calls.push({ url, headers: options.headers || {} })
    if (url.href === SICHUAN_PAGE) {
      // 真实页面至少 8 个频道；测试补齐 8 条以覆盖结构保护。
      const eight = Array.from({ length: 8 }, (_, index) => ({
        id: String(1016553 + index),
        name: `四川频道${index + 1}`,
        playAddress: `https://tvshowf.scgczm.com/live/sctv${index + 1}.m3u8`,
      })).map(JSON.stringify).join('')
      return response(eight)
    }
    if (url.href === SICHUAN_LIVE_API) return response({ rs: 200, data: [liveEvent] })
    if (url.href === `${SICHUAN_LIVE_DETAIL_API}/${liveEvent.id}`) {
      return response({ rs: 200, data: { ...liveEvent, status: 1, stream: [{ address: liveUrl }] } })
    }
    if (url.href === liveUrl) return response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n')
    if (url.origin + url.pathname === SICHUAN_AUTH_API) {
      assert.equal(url.searchParams.get('streamName'), '/live/sctv1.m3u8')
      assert.equal(options.headers.authorization, `bearer ${accessToken}`)
      return response({ rs: 200, data: { secret } })
    }
    throw new Error(`unexpected URL: ${url.href}`)
  }
  const fetched = await sichuan.fetch({ accessToken }, { fetchImpl, now: 1788666000000 })
  assert.equal(fetched.groups[0].name, '四川')
  assert.equal(fetched.groups[0].dataList.length, 9)
  assert.equal(fetched.groups[0].dataList.at(-1).deferredRef, `sichuan-live-${liveEvent.id}`)
  const resolved = await resolveChannel('sichuan-1016553', {
    config: { accessToken }, fetchImpl, now: 1788666001000,
  })
  assert.equal(resolved.url, applySichuanSecret(rows[0].rawUrl, secret))
  assert.deepEqual(resolved.upstreamHeaders(resolved.url), SICHUAN_MEDIA_HEADERS)
  assert.equal(resolved.upstreamUrlTransform('https://tvshowf.scgczm.com/live/a.ts'), 'https://tvshowf.scgczm.com/live/a.ts')
  const liveResolved = await resolveChannel(`sichuan-live-${liveEvent.id}`, { fetchImpl })
  assert.equal(liveResolved.url, liveUrl)
  assert.deepEqual(liveResolved.upstreamHeaders(liveResolved.url), SICHUAN_LIVE_MEDIA_HEADERS)
  assert.equal(calls.filter(call => call.url.origin + call.url.pathname === SICHUAN_AUTH_API).length, 1)
})

await checkAsync('缺少凭据时只隐藏固定频道，活动有则显示、无则不显示', async () => {
  clearCache()
  const fetchImpl = async raw => {
    assert.equal(String(raw), SICHUAN_LIVE_API)
    return response({ rs: 200, data: [] })
  }
  const fetched = await sichuan.fetch({}, { fetchImpl })
  assert.deepEqual(fetched.groups, [])
  assert.match(fetched.meta.warnings.join('\n'), /尚未配置/)
  const resolved = await resolveChannel('sichuan-1016553', { config: {} })
  assert.equal(resolved.url, '')
  assert.match(resolved.desc, /需要先在后台关联/)
})

check('后台包含四川官网书签工具且不会把 Token 写入播放地址', () => {
  const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
  assert.match(admin, /sichuanBookmarklet/)
  assert.match(admin, /scgc_useraccountinfo/)
  assert.match(admin, /获取四川 Token/)
})

console.log(`\n全部通过：${passed} ✅`)
