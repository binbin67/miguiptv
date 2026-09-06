#!/usr/bin/env node
import assert from 'node:assert/strict'

import gansu from '../extractors/gansu/index.js'
import {
  CHANNELS,
  CHANNEL_LIST_HARD_TTL_MS,
  GANSU_CHANNEL_API,
  buildChannels,
  claimsRef,
  createResolver,
  officialAssetUrl,
  officialHlsUrl,
  parseChannelList,
  requestChannelUrls,
  upstreamHeadersFor,
  validateHls,
} from '../extractors/gansu/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const response = (body, status = 200, headers = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers },
)

function apiPayload(overrides = {}) {
  return {
    code: '200',
    success: true,
    data: CHANNELS.map(channel => ({
      id: channel.channelId,
      liveTitle: channel.rawName,
      type: 1,
      shelfStatus: 1,
      liveUrl: `https://live.gstv.com.cn/live/channel${channel.channelId}.m3u8`,
      ...(overrides[channel.channelId] || {}),
    })),
  }
}

const mediaManifest = sequence => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:4,\npart-${sequence}.ts\n`

console.log('甘肃广电模块测试')

check('模块注册为免账号的甘肃清单中继模块', () => {
  assert.equal(getModule('gansu'), gansu)
  assert.equal(gansu.name, '甘肃')
  assert.equal(gansu.category, undefined)
  assert.equal(gansu.channelHlsMode, 'relay')
  assert.equal(gansu.relayProxyCompatible, true)
  assert.equal(gansu.capabilities.catchup, false)
  assert.equal(gansu.catalogVersion, 1)
  assert.deepEqual(gansu.configSchema, [])
  assert.equal(resolverFor('gansu-1'), gansu)
  assert.equal(resolverFor('gansu-6'), gansu)
  assert.equal(resolverFor('gansu-1/extra'), null)
})

await checkAsync('官网六路固定输出为独立甘肃分组', async () => {
  assert.deepEqual(CHANNELS.map(channel => [channel.channelId, channel.rawName]), [
    ['1', '甘肃卫视'],
    ['2', '文化影视'],
    ['3', '移动电视'],
    ['4', '少儿频道'],
    ['5', '科教频道'],
    ['6', '公共应急'],
  ])
  assert.deepEqual(CHANNELS.map(channel => channel.name), [
    '甘肃卫视', '甘肃文化影视', '甘肃移动电视', '甘肃少儿', '甘肃科教', '甘肃公共应急',
  ])
  const channels = buildChannels()
  assert.deepEqual(channels.map(channel => channel.deferredRef), [
    'gansu-1', 'gansu-2', 'gansu-3', 'gansu-4', 'gansu-5', 'gansu-6',
  ])
  assert.ok(channels.every(channel => channel.catchup === 'none'))
  assert.ok(channels.every(channel => channel.logo.startsWith('https://jiangsu-10.zos.ctyun.cn/gansu/')))
  assert.equal(claimsRef('gansu-1'), true)
  assert.equal(claimsRef('gansu-7'), false)
  const result = await gansu.fetch()
  assert.deepEqual(result.groups, [{ name: '甘肃', dataList: channels }])
})

await checkAsync('频道接口请求与公开响应格式严格固定', async () => {
  let requests = 0
  const urls = await requestChannelUrls({
    fetchImpl: async (url, options) => {
      requests++
      assert.equal(url, GANSU_CHANNEL_API)
      assert.equal(options.method, 'POST')
      assert.equal(options.redirect, 'manual')
      assert.deepEqual(JSON.parse(options.body), { type: 1 })
      assert.equal(options.headers.Origin, 'https://www.gstv.com.cn')
      assert.equal(options.headers.Referer, 'https://www.gstv.com.cn/')
      return response(apiPayload())
    },
  })
  assert.equal(requests, 1)
  assert.equal(urls.size, 6)
  assert.equal(urls.get('gansu-1'), 'https://live.gstv.com.cn/live/channel1.m3u8')

  const partial = parseChannelList(apiPayload({ 4: { liveTitle: '异常名称' } }))
  assert.equal(partial.size, 5)
  assert.equal(partial.has('gansu-4'), false)
  assert.throws(() => parseChannelList('{broken'), /有效 JSON/)
  assert.throws(() => parseChannelList({ code: '500', data: [] }), /返回异常/)
  await assert.rejects(requestChannelUrls({
    fetchImpl: async () => response('', 302, { Location: 'https://example.com/' }),
  }), /不安全的重定向/)
  await assert.rejects(requestChannelUrls({
    fetchImpl: async () => response('x'.repeat(512 * 1024 + 1)),
  }), /响应过大/)
})

check('媒体白名单覆盖清单和分片并拒绝任意外部地址', () => {
  const stream = 'https://live.gstv.com.cn/live/oxfhvoy.m3u8'
  assert.equal(officialHlsUrl(stream), stream)
  assert.match(officialAssetUrl('https://live.gstv.com.cn/live/part-1.ts?ctyun_stream=x'), /part-1\.ts/)
  assert.deepEqual(upstreamHeadersFor(stream), {
    Origin: 'https://www.gstv.com.cn',
    Referer: 'https://www.gstv.com.cn/',
  })
  assert.equal(validateHls('#EXTM3U\n#EXTINF:4,\npart.ts\n', stream).startsWith('#EXTM3U'), true)
  for (const bad of [
    'http://live.gstv.com.cn/live/a.ts',
    'https://live.gstv.com.cn.evil.test/live/a.ts',
    'https://127.0.0.1/live/a.ts',
    'https://user:pass@live.gstv.com.cn/live/a.ts',
    'https://live.gstv.com.cn/private/a.ts',
  ]) assert.throws(() => officialAssetUrl(bad))
  assert.throws(() => validateHls('#EXTM3U\n#EXTINF:4,\nhttps://example.com/a.ts\n', stream))
})

await checkAsync('六路共享频道表请求，但每次播放都刷新滚动清单', async () => {
  let apiRequests = 0
  let manifestRequests = 0
  const fetchImpl = async url => {
    if (url === GANSU_CHANNEL_API) {
      apiRequests++
      return response(apiPayload())
    }
    manifestRequests++
    return response(mediaManifest(manifestRequests))
  }
  const resolver = createResolver({ fetchImpl })
  const [satellite, culture] = await Promise.all([
    resolver.resolve('gansu-1', { now: 1_000 }),
    resolver.resolve('gansu-2', { now: 1_000 }),
  ])
  const refreshed = await resolver.resolve('gansu-1', { now: 2_000 })
  assert.equal(apiRequests, 1)
  assert.equal(manifestRequests, 3)
  assert.match(satellite.manifestText, /MEDIA-SEQUENCE:1/)
  assert.match(culture.manifestText, /MEDIA-SEQUENCE:2/)
  assert.match(refreshed.manifestText, /MEDIA-SEQUENCE:3/)
  assert.equal(refreshed.relayHls, true)
  assert.equal(refreshed.url, 'https://live.gstv.com.cn/live/channel1.m3u8')
  assert.equal(refreshed.upstreamUrlTransform('https://live.gstv.com.cn/live/part.ts'), 'https://live.gstv.com.cn/live/part.ts')
})

await checkAsync('接口短暂失败时使用旧入口并遵守十秒退避', async () => {
  let apiRequests = 0
  let apiDown = false
  const fetchImpl = async url => {
    if (url === GANSU_CHANNEL_API) {
      apiRequests++
      return apiDown ? response('temporary failure', 503) : response(apiPayload())
    }
    return response(mediaManifest(1))
  }
  const resolver = createResolver({ fetchImpl })
  await resolver.resolve('gansu-1', { now: 1_000 })
  apiDown = true
  const fallback = await resolver.resolve('gansu-3', { now: 61_001 })
  const backedOff = await resolver.resolve('gansu-4', { now: 65_000 })
  assert.notEqual(fallback.url, '')
  assert.notEqual(backedOff.url, '')
  assert.equal(apiRequests, 2)
})

await checkAsync('单路异常保留旧值至硬期限，但不拖垮其他频道', async () => {
  let apiRequests = 0
  let kidsInvalid = false
  const fetchImpl = async url => {
    if (url === GANSU_CHANNEL_API) {
      apiRequests++
      return response(apiPayload(kidsInvalid ? { 4: { liveTitle: '临时异常名称' } } : {}))
    }
    return response(mediaManifest(1))
  }
  const resolver = createResolver({ fetchImpl })
  await resolver.resolve('gansu-4', { now: 1_000 })
  kidsInvalid = true
  const staleKids = await resolver.resolve('gansu-4', { now: 61_001 })
  const healthy = await resolver.resolve('gansu-1', { now: 61_002 })
  assert.notEqual(staleKids.url, '')
  assert.notEqual(healthy.url, '')

  const expiredKids = await resolver.resolve('gansu-4', {
    now: 1_001 + CHANNEL_LIST_HARD_TTL_MS,
  })
  assert.equal(expiredKids.url, '')
  assert.match(expiredKids.desc, /当前不在官网有效直播列表/)
  assert.equal(apiRequests, 3)
})

await checkAsync('旧入口失效时立即重读频道表并恢复新入口', async () => {
  const oldStream = 'https://live.gstv.com.cn/live/oldentry.m3u8'
  const newStream = 'https://live.gstv.com.cn/live/newentry.m3u8'
  let apiRequests = 0
  const fetchImpl = async url => {
    if (url === GANSU_CHANNEL_API) {
      apiRequests++
      return response(apiPayload({
        1: { liveUrl: apiRequests === 1 ? oldStream : newStream },
      }))
    }
    if (url === oldStream) return response('gone', 404)
    if (url === newStream) return response(mediaManifest(9))
    throw new Error(`unexpected URL: ${url}`)
  }
  const resolver = createResolver({ fetchImpl })
  const recovered = await resolver.resolve('gansu-1', { now: 1_000 })
  assert.equal(recovered.url, newStream)
  assert.match(recovered.manifestText, /MEDIA-SEQUENCE:9/)
  assert.equal(apiRequests, 2)
})

await checkAsync('清缓存时在途旧请求不会覆盖新结果', async () => {
  const oldStream = 'https://live.gstv.com.cn/live/oldentry.m3u8'
  const newStream = 'https://live.gstv.com.cn/live/newentry.m3u8'
  let apiRequests = 0
  let releaseFirst
  const firstResponse = new Promise(resolve => { releaseFirst = resolve })
  const fetchImpl = async url => {
    if (url === GANSU_CHANNEL_API) {
      apiRequests++
      if (apiRequests === 1) return firstResponse
      return response(apiPayload({ 1: { liveUrl: newStream } }))
    }
    return response(mediaManifest(url === oldStream ? 1 : 2))
  }
  const resolver = createResolver({ fetchImpl })
  const oldRequest = resolver.resolve('gansu-1', { now: 1_000 })
  assert.equal(apiRequests, 1)
  resolver.clear()
  const newResult = await resolver.resolve('gansu-1', { now: 1_000 })
  releaseFirst(response(apiPayload({ 1: { liveUrl: oldStream } })))
  const oldResult = await oldRequest
  const cachedResult = await resolver.resolve('gansu-1', { now: 2_000 })
  assert.equal(newResult.url, newStream)
  assert.equal(oldResult.url, oldStream)
  assert.equal(cachedResult.url, newStream)
  assert.equal(apiRequests, 2)
})

await checkAsync('清缓存前的失败请求不会借用或退避新一代缓存', async () => {
  const newStream = 'https://live.gstv.com.cn/live/newentry.m3u8'
  let apiRequests = 0
  let rejectFirst
  const firstResponse = new Promise((_, reject) => { rejectFirst = reject })
  const fetchImpl = async url => {
    if (url === GANSU_CHANNEL_API) {
      apiRequests++
      if (apiRequests === 1) return firstResponse
      return response(apiPayload({ 1: { liveUrl: newStream } }))
    }
    return response(mediaManifest(2))
  }
  const resolver = createResolver({ fetchImpl })
  const oldRequest = resolver.resolve('gansu-1', { now: 1_000 })
  resolver.clear()
  const newResult = await resolver.resolve('gansu-1', { now: 1_000 })
  rejectFirst(new Error('old generation failed'))
  const oldResult = await oldRequest
  const cachedResult = await resolver.resolve('gansu-1', { now: 2_000 })
  assert.equal(oldResult.url, '')
  assert.match(oldResult.desc, /old generation failed/)
  assert.equal(newResult.url, newStream)
  assert.equal(cachedResult.url, newStream)
  assert.equal(apiRequests, 2)
})

await checkAsync('非法引用和上游异常只返回说明，不向请求处理器抛错', async () => {
  const resolver = createResolver({
    fetchImpl: async url => {
      if (url === GANSU_CHANNEL_API) return response('upstream error', 500)
      throw new Error('不应请求媒体')
    },
  })
  const malformed = await resolver.resolve('gansu-7')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
  const failed = await resolver.resolve('gansu-1', { now: 1_000 })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /请求失败.*HTTP 500/)
})

console.log(`\n全部通过：${passed} ✅`)
