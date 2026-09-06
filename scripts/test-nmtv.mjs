#!/usr/bin/env node
import assert from 'node:assert/strict'

import nmtv from '../extractors/nmtv/index.js'
import {
  CHANNELS,
  NMTV_API,
  NMTV_API_KEY,
  buildChannels,
  buildPortalRequest,
  claimsRef,
  clearCache,
  fetchPortalChannels,
  officialAssetUrl,
  officialHlsUrl,
  parsePortalResponse,
  resolveChannel,
  upstreamHeadersFor,
} from '../extractors/nmtv/api.js'
import { decryptBase64, encryptBase64 } from '../extractors/nmtv/xxtea.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

const encryptedEmpty = 'gEGX8JB5ZQKq+Vc4SKMEyT+xgtSix+I+LPgGAaXXd4GwFyhFUzPvK6xaOeZY+jB4mYuYDD2+mI+oT+mipRebww=='
const dynamic = 'https://livestream-bt.nmtv.cn/nmtv/2316general.m3u8?txSecret=test&txTime=771E8800&token=test'

console.log('内蒙古广电模块测试')

check('模块注册为免账号的内蒙古全代理模块', () => {
  assert.equal(getModule('nmtv'), nmtv)
  assert.equal(nmtv.name, '内蒙古')
  assert.equal(nmtv.category, undefined)
  assert.equal(nmtv.outputGroupName, '内蒙古')
  assert.equal(nmtv.channelHlsMode, 'proxy')
  assert.equal(nmtv.capabilities.catchup, false)
  assert.equal(nmtv.catalogVersion, 1)
  assert.deepEqual(nmtv.configSchema, [])
  assert.equal(resolverFor('nmtv-satellite'), nmtv)
  assert.equal(resolverFor('nmtv-satellite/extra'), null)
})

await checkAsync('官网当前 20 路频道全部归入唯一的内蒙古分组', async () => {
  assert.equal(CHANNELS.length, 20)
  assert.deepEqual(CHANNELS.slice(0, 8).map(channel => channel.name), [
    '内蒙古卫视', '内蒙古蒙古语卫视', '新闻综合', '经济生活',
    '少儿频道', '文体娱乐', '农牧频道', '内蒙古蒙古语文化频道',
  ])
  assert.deepEqual(CHANNELS.slice(8).map(channel => channel.name), [
    '呼和浩特', '包头', '乌海', '赤峰', '呼伦贝尔', '兴安盟',
    '通辽', '锡林郭勒', '乌兰察布', '鄂尔多斯', '巴彦淖尔', '阿拉善',
  ])
  const channels = buildChannels()
  assert.deepEqual(channels.map(channel => channel.deferredRef), CHANNELS.map(channel => channel.ref))
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  const result = await nmtv.fetch()
  assert.deepEqual(result.groups, [{ name: '内蒙古', dataList: channels }])
  assert.equal(claimsRef('nmtv-alxa'), true)
  assert.equal(claimsRef('nmtv-unknown'), false)
})

check('XXTEA 与官网加密响应格式兼容', () => {
  const clear = JSON.stringify({ code: 0, data: [{ id: 2316, title: '新闻综合' }], success: true })
  assert.equal(decryptBase64(encryptBase64(clear, NMTV_API_KEY), NMTV_API_KEY), clear)
  assert.deepEqual(parsePortalResponse(JSON.stringify(encryptedEmpty)), [])
  assert.deepEqual(parsePortalResponse(clear), [{ id: 2316, title: '新闻综合' }])
  assert.throws(() => parsePortalResponse('"not-base64"'))
})

await checkAsync('频道请求使用官网加密 POST 协议', async () => {
  const request = buildPortalRequest()
  assert.equal(request.url, NMTV_API)
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.headers['Client-Type'], 'web')
  assert.equal(request.options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(decryptBase64(request.options.body, NMTV_API_KEY)), { type: 1, size: 100 })

  const fetchImpl = async (url, options) => {
    assert.equal(url, NMTV_API)
    assert.equal(options.method, 'POST')
    return response(JSON.stringify(encryptBase64(JSON.stringify({
      code: 0, data: [{ id: 2316 }], success: true,
    }), NMTV_API_KEY)))
  }
  assert.deepEqual(await fetchPortalChannels({ fetchImpl }), [{ id: 2316 }])
})

check('媒体白名单覆盖清单和分片并拒绝任意回源', () => {
  assert.equal(officialHlsUrl(dynamic), dynamic)
  assert.match(officialAssetUrl('https://livestream-bt.nmtv.cn/nmtv/2316general-1.ts?x=1'), /\.ts\?x=1$/)
  assert.equal(officialHlsUrl('http://play1-qk.nmtv.cn/live/1769652018126032.m3u8'),
    'http://play1-qk.nmtv.cn/live/1769652018126032.m3u8')
  assert.deepEqual(upstreamHeadersFor(dynamic), { Referer: 'https://www.nmtv.cn/' })
  for (const bad of [
    'https://evil.test/nmtv/a.ts',
    'https://livestream-bt.nmtv.cn.evil.test/nmtv/a.ts',
    'http://livestream-bt.nmtv.cn/nmtv/a.ts',
    'http://play1-qk.nmtv.cn:8080/live/a.ts',
    'https://user:pass@livestream-bt.nmtv.cn/nmtv/a.ts',
    'https://livestream-bt.nmtv.cn/private/a.ts',
  ]) assert.throws(() => officialAssetUrl(bad))
  assert.throws(() => officialHlsUrl('https://livestream-bt.nmtv.cn/nmtv/a.ts'), /不是 HLS/)
})

await checkAsync('播放时按频道 ID 取动态地址并短期复用频道列表', async () => {
  clearCache()
  let requests = 0
  const fetchImpl = async () => {
    requests++
    return response({ code: 0, data: [{
      id: 2316, title: '新闻综合', data: { streamUrl: dynamic },
    }] })
  }
  const first = await resolveChannel('nmtv-news-general', { fetchImpl, now: 1000 })
  const second = await resolveChannel('nmtv-news-general', { fetchImpl, now: 2000 })
  assert.equal(requests, 1)
  assert.equal(first.url, dynamic)
  assert.equal(second.url, dynamic)
  assert.deepEqual(first.upstreamHeaders(dynamic), { Referer: 'https://www.nmtv.cn/' })
  assert.match(first.upstreamUrlTransform('https://livestream-bt.nmtv.cn/nmtv/2316general-1.ts'), /\.ts$/)
})

await checkAsync('拒绝频道错配，接口失败时只给两路已验证备用入口', async () => {
  clearCache()
  const mismatched = await resolveChannel('nmtv-news-general', {
    fetchImpl: async () => response({ code: 0, data: [{
      id: 2316, title: '新闻综合',
      data: { streamUrl: 'https://livestream-bt.nmtv.cn/nmtv/2317general.m3u8' },
    }] }),
  })
  assert.equal(mismatched.url, '')
  assert.match(mismatched.desc, /频道与请求不一致/)

  clearCache()
  const empty = async () => response({ code: 0, data: [] })
  const fallback = await resolveChannel('nmtv-satellite', { fetchImpl: empty })
  assert.match(fallback.url, /^http:\/\/play1-qk\.nmtv\.cn\/live\//)
  assert.match(fallback.desc, /备用入口/)

  clearCache()
  const unavailable = await resolveChannel('nmtv-news-general', { fetchImpl: empty })
  assert.equal(unavailable.url, '')
  assert.match(unavailable.desc, /没有返回新闻综合直播地址/)

  const malformed = await resolveChannel('nmtv-unknown', {
    fetchImpl: async () => { throw new Error('不应请求') },
  })
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
})

console.log(`\n全部通过：${passed} ✅`)
