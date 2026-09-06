#!/usr/bin/env node
import assert from 'node:assert/strict'

import jlntv from '../extractors/jlntv/index.js'
import {
  API_ORIGIN,
  BROADCAST_CHANNELS,
  SCENIC_CHANNELS,
  buildGroups,
  claimsRef,
  clearCache,
  decryptJlntvResponse,
  officialAssetUrl,
  officialHlsUrl,
  parseBroadcast,
  resolveChannel,
  selectStreamDetail,
  validateDynamicStreamUrl,
} from '../extractors/jlntv/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const now = 1_700_000_000_000
const stream = 'https://hls.avap.jilintv.cn/zqvk7vpj/channel/abc123/index.m3u8?txSecret=0123456789abcdef0123456789abcdef&txTime=70000000'
const TV_CIPHER = '3VsyRtE2D+ZKE2fIIw4hf3cgRUNf5T/wevvi6KYB7MwW0XCpD+mZ/iI5rhyppwDH39xMwrjrkKOXBUaXx/Yz9B5CtTOTcducs9+4mpWyAHS+yLQVn005hHpeqsKb+/J8+8B2wv1ziAFer1ybMQyKwcjPwbV0TSI/G7GNNoeWUWjVYeZUiDpLj/FPegHiZylFFhkHEY8zKOQdVqRdg76BZ5nJpoWm+33pHAnZgdT+33v417QBjVykanGFYM25XndCmZXDs9PU3LRXDebvw7gKLRdQsrL+ZegMX9cblf4bW1ggbQ+OWjDAhK+qS5guY+Viue9puSIZvsKUJTaF'

console.log('吉林广电模块测试')

check('模块注册为免账号吉林全代理模块，并保留吉林风景分组', () => {
  assert.equal(getModule('jlntv'), jlntv)
  assert.equal(jlntv.name, '吉林')
  assert.equal(jlntv.category, undefined)
  assert.equal(jlntv.channelHlsMode, 'proxy')
  assert.deepEqual(jlntv.preserveGroupSuffixes, ['风景'])
  assert.equal(jlntv.capabilities.catchup, false)
  assert.equal(jlntv.catalogVersion, 1)
  assert.equal(resolverFor('jlntv-satellite'), jlntv)
  assert.equal(resolverFor('jlntv-satellite/extra'), null)
})

await checkAsync('固定输出吉林 15 路、吉林风景 13 路', async () => {
  assert.equal(BROADCAST_CHANNELS.length, 15)
  assert.equal(SCENIC_CHANNELS.length, 13)
  const groups = buildGroups()
  assert.deepEqual(groups.map(group => [group.name, group.dataList.length]), [
    ['吉林', 15], ['吉林风景', 13],
  ])
  assert.ok(groups.flatMap(group => group.dataList).every(channel =>
    channel.deferredRef.startsWith('jlntv-') && channel.catchup === 'none'))
  assert.deepEqual((await jlntv.fetch()).groups, groups)
})

check('XXTEA 响应只按数据解密，不执行返回内容', () => {
  assert.deepEqual(decryptJlntvResponse('"TE1nyYDOPQJDbJsvLyJk4Q=="'), { code: 0 })
  assert.throws(() => decryptJlntvResponse('{"data":"process.env"}'), /密文/)
  assert.throws(() => decryptJlntvResponse('not-json'), /JSON/)
})

check('省级频道按 ID、原名、索引和签名有效期四重校验', () => {
  const channel = BROADCAST_CHANNELS[0]
  assert.equal(parseBroadcast(JSON.stringify(TV_CIPHER), channel, { now }), stream)
  assert.throws(() => parseBroadcast(JSON.stringify(TV_CIPHER), {
    ...channel, broadcastId: '1532', rawName: '都市频道',
  }, { now }), /指定电视频道/)
  assert.throws(() => validateDynamicStreamUrl(stream, Number.parseInt('70000000', 16) * 1000), /过期/)
  assert.throws(() => validateDynamicStreamUrl(stream.replace('hls.avap.jilintv.cn', 'evil.test'), now), /非官方/)
})

check('慢直播主机位和子机位都要求内容 ID 与机位名精确匹配', () => {
  const payload = {
    code: 0,
    data: {
      id: '659599', contentType: 'stream',
      data: {
        name: '长春市·新民广场', playUrl: stream,
        subStreams: [{ name: '长春市·双阳区', playUrl: stream }],
      },
    },
  }
  assert.equal(selectStreamDetail(payload, SCENIC_CHANNELS[0], { now }), stream)
  assert.equal(selectStreamDetail(payload, SCENIC_CHANNELS[1], { now }), stream)
  assert.throws(() => selectStreamDetail(payload, { ...SCENIC_CHANNELS[1], streamName: '未知机位' }, { now }), /指定慢直播机位/)
})

check('媒体白名单覆盖清单、密钥和分片，并拒绝任意回源', () => {
  assert.equal(officialHlsUrl(BROADCAST_CHANNELS[6].url), BROADCAST_CHANNELS[6].url)
  assert.match(officialAssetUrl('https://stream2.jlntv.cn/jlcc/sd/segment.ts'), /segment\.ts$/)
  assert.match(officialAssetUrl('https://lsfb.avap.jilintv.cn/zqvk7vpj/channel/abc/key.bin'), /key\.bin$/)
  for (const bad of [
    'http://stream2.jlntv.cn/a.ts',
    'https://stream2.jlntv.cn.evil.test/a.ts',
    'https://127.0.0.1/a.ts',
    'https://user:pass@stream2.jlntv.cn/a.ts',
    'https://stream2.jlntv.cn:444/a.ts',
  ]) assert.throws(() => officialAssetUrl(bad))
  assert.throws(() => officialHlsUrl('https://stream2.jlntv.cn/a.ts'), /不是 HLS/)
})

await checkAsync('播放时请求官方接口、校验请求头并短期复用响应', async () => {
  clearCache()
  let requests = 0
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw)
    assert.equal(url.origin, API_ORIGIN)
    assert.equal(url.pathname, '/broadcast/list')
    assert.equal(url.searchParams.get('type'), '1')
    assert.equal(new Headers(options.headers).get('client-type'), 'web')
    requests++
    return new Response(JSON.stringify(TV_CIPHER))
  }
  const first = await resolveChannel('jlntv-satellite', { fetchImpl, now })
  const second = await resolveChannel('jlntv-satellite', { fetchImpl, now: now + 1000 })
  assert.equal(requests, 1)
  assert.equal(first.url, stream)
  assert.equal(second.url, stream)
  assert.deepEqual(first.upstreamHeaders(stream), {
    Origin: 'https://www.jlntv.cn',
    Referer: 'https://www.jlntv.cn/tv?id=104',
  })
  assert.equal(first.upstreamUrlTransform('https://hls.avap.jilintv.cn/zqvk7vpj/channel/abc123/seg.ts'),
    'https://hls.avap.jilintv.cn/zqvk7vpj/channel/abc123/seg.ts')
})

await checkAsync('固定频道不访问 API，错误也只返回说明而不向请求处理器抛出', async () => {
  const fixed = await resolveChannel('jlntv-changchun', {
    fetchImpl: async () => { throw new Error('固定频道不应请求 API') },
  })
  assert.equal(fixed.url, BROADCAST_CHANNELS.find(channel => channel.ref === 'jlntv-changchun').url)
  assert.equal(claimsRef('jlntv-changchun'), true)
  assert.equal(claimsRef('jlntv-unknown'), false)

  clearCache()
  const failed = await resolveChannel('jlntv-satellite', {
    fetchImpl: async () => new Response('upstream error', { status: 500 }),
    now,
  })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /链接请求失败.*HTTP 500/)
  const malformed = await resolveChannel('jlntv-unknown')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
})

console.log(`\n全部通过：${passed} ✅`)
