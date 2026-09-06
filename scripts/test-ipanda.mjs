#!/usr/bin/env node
import assert from 'node:assert/strict'

import ipanda from '../extractors/ipanda/index.js'
import {
  CAMERA_HOST,
  IPANDA_GROUP,
  SOURCES,
  buildGroups,
  claimsRef,
  sourceFromRef,
} from '../extractors/ipanda/channels.js'
import {
  DYNAMIC_HOSTS,
  LIVE_API_HOST,
  STREAM_TTL_MS,
  allowUrl,
  createResolver,
  fetchText,
  hasMediaSegment,
  highestVariantUrl,
  parseLiveApi,
  validateHls,
} from '../extractors/ipanda/api.js'
import { getModule, resolverFor } from '../extractors/registry.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

const response = (body, status = 200, headers = {}) => new Response(body, { status, headers })
const liveApi = (hlsUrl, extra = {}) => {
  const data = {
    ack: 'yes', status: '1', play: '1', public: '1',
    hls_url: { hls1: hlsUrl, hls4: hlsUrl, hls2: hlsUrl },
    ...extra,
  }
  return `var html5VideoData = '${JSON.stringify(data)}';getHtml5VideoData(html5VideoData);`
}

console.log('iPanda 官方直播模块测试')

check('模块已注册为零配置 iPanda 混合路由模块', () => {
  assert.equal(getModule('ipanda'), ipanda)
  assert.equal(ipanda.name, 'iPanda 官方直播')
  assert.equal(ipanda.outputGroupName, 'iPanda')
  assert.equal(ipanda.catalogVersion, 1)
  assert.equal(ipanda.capabilities.resolve, true)
  assert.equal(ipanda.capabilities.catchup, false)
  assert.equal(ipanda.channelHlsMode, undefined)
  assert.deepEqual(ipanda.configSchema, [])
  assert.equal(resolverFor('ipanda-chengdu'), ipanda)
  assert.equal(resolverFor('ipanda-jiangsu-dafeng-milu'), ipanda)
  assert.equal(resolverFor('ipanda-chengdu-adult-a'), null)
  assert.equal(resolverFor('ipanda-chengdu/extra'), null)
})

await checkAsync('二十二路统一归类 iPanda，十八路直连、四路动态全代理', async () => {
  assert.equal(SOURCES.length, 22)
  assert.equal(new Set(SOURCES.map(source => source.id)).size, 22)
  assert.ok(SOURCES.every(source => source.page.startsWith('https://live.ipanda.com/')))
  const result = await ipanda.fetch()
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].name, IPANDA_GROUP)
  assert.deepEqual(result.groups, buildGroups())
  const channels = result.groups[0].dataList
  assert.equal(channels.length, 22)
  assert.equal(channels.filter(channel => channel.url).length, 18)
  assert.equal(channels.filter(channel => channel.deferredRef && channel.proxyHls).length, 4)
  assert.ok(channels.filter(channel => channel.url)
    .every(channel => channel.url.startsWith(`https://${CAMERA_HOST}/gcwbnd/`)))
  assert.ok(channels.every(channel => channel.catchup === 'none' && channel.logo))
})

check('动态引用只精确认领四路，珍稀动物对应 xiongmao23/24', () => {
  assert.deepEqual(SOURCES.filter(source => source.dynamic).map(source => source.channel), [
    'ipanda', 'ipanda1000', 'xiongmao23', 'xiongmao24',
  ])
  assert.equal(sourceFromRef('ipanda-jiangsu-dafeng-milu')?.channel, 'xiongmao23')
  assert.equal(sourceFromRef('ipanda-yunnan-baima-snow-mountain')?.channel, 'xiongmao24')
  assert.equal(claimsRef('ipanda-dujiangyan'), true)
  assert.equal(claimsRef('ipanda-chengdu-adult-a'), false)
  assert.equal(claimsRef('ipanda-unknown'), false)
})

check('二十二路官网页面、名称与频道标识完整锁定', () => {
  assert.deepEqual(SOURCES.map(({ id, name, page, channel }) => ({ id, name, page, channel })), [
    { id: 'chengdu', name: '成都基地 24小时', page: 'https://live.ipanda.com/xmcd/', channel: 'ipanda' },
    { id: 'chengdu-adult-a', name: '成都·成年园A', page: 'https://live.ipanda.com/xmcd/01/index.shtml', channel: 'xiongmao01' },
    { id: 'chengdu-adult-b', name: '成都·成年园B', page: 'https://live.ipanda.com/xmcd/02/index.shtml', channel: 'xiongmao02' },
    { id: 'chengdu-villa-6-a', name: '成都·六号别墅A', page: 'https://live.ipanda.com/xmcd/03/index.shtml', channel: 'xiongmao03' },
    { id: 'chengdu-villa-6-b', name: '成都·六号别墅B', page: 'https://live.ipanda.com/xmcd/04/index.shtml', channel: 'xiongmao04' },
    { id: 'chengdu-nursery-a', name: '成都·幼儿园A', page: 'https://live.ipanda.com/xmcd/05/index.shtml', channel: 'xiongmao05' },
    { id: 'chengdu-nursery-b', name: '成都·幼儿园B', page: 'https://live.ipanda.com/xmcd/06/index.shtml', channel: 'xiongmao06' },
    { id: 'chengdu-mother-cub-a', name: '成都·母子园A', page: 'https://live.ipanda.com/xmcd/07/index.shtml', channel: 'xiongmao07' },
    { id: 'chengdu-mother-cub-b', name: '成都·母子园B', page: 'https://live.ipanda.com/xmcd/08/index.shtml', channel: 'xiongmao08' },
    { id: 'chengdu-villa-1-a', name: '成都·一号别墅A', page: 'https://live.ipanda.com/xmcd/09/index.shtml', channel: 'xiongmao09' },
    { id: 'chengdu-villa-1-b', name: '成都·一号别墅B', page: 'https://live.ipanda.com/xmcd/10/index.shtml', channel: 'xiongmao10' },
    { id: 'dujiangyan', name: '都江堰 24小时', page: 'https://live.ipanda.com/xmwl/index.shtml', channel: 'ipanda1000' },
    { id: 'dujiangyan-jifu-a', name: '都江堰·吉福A', page: 'https://live.ipanda.com/xmwl/01/index.shtml', channel: 'xiongmao11' },
    { id: 'dujiangyan-ruixi-qiaoyi-a', name: '都江堰·瑞喜、乔怡A', page: 'https://live.ipanda.com/xmwl/02/index.shtml', channel: 'xiongmao12' },
    { id: 'dujiangyan-xinqiao', name: '都江堰·新乔', page: 'https://live.ipanda.com/xmwl/03/index.shtml', channel: 'xiongmao13' },
    { id: 'dujiangyan-qingling', name: '都江堰·青灵', page: 'https://live.ipanda.com/xmwl/04/index.shtml', channel: 'xiongmao14' },
    { id: 'dujiangyan-youyou', name: '都江堰·优悠', page: 'https://live.ipanda.com/xmwl/05/index.shtml', channel: 'xiongmao15' },
    { id: 'dujiangyan-ruixi-qiaoyi-b', name: '都江堰·瑞喜、乔怡B', page: 'https://live.ipanda.com/xmwl/06/index.shtml', channel: 'xiongmao16' },
    { id: 'dujiangyan-jifu-b', name: '都江堰·吉福B', page: 'https://live.ipanda.com/xmwl/08/index.shtml', channel: 'xiongmao18' },
    { id: 'dujiangyan-chunye-qiuye', name: '都江堰·春野、秋野', page: 'https://live.ipanda.com/xmwl/11/index.shtml', channel: 'xiongmao20' },
    { id: 'jiangsu-dafeng-milu', name: '江苏大丰麋鹿国家级自然保护区', page: 'https://live.ipanda.com/zxwz/milu/index.shtml', channel: 'xiongmao23' },
    { id: 'yunnan-baima-snow-mountain', name: '云南白马雪山自然保护区', page: 'https://live.ipanda.com/zxwz/bmxs/index.shtml', channel: 'xiongmao24' },
  ])
})

check('官网匿名接口必须公开可播，并拒绝非官方媒体地址', () => {
  const good = 'https://gcwbndtxy.liveplay.myqcloud.com/gcwbnd/ipanda_2/index.m3u8'
  assert.deepEqual(parseLiveApi(liveApi(good)), [good])
  assert.throws(() => parseLiveApi(liveApi(good, { public: '0' })), /匿名公开/)
  assert.throws(() => parseLiveApi(liveApi('https://evil.test/live.m3u8')), /HTTPS HLS/)
  assert.equal(allowUrl(good), good)
  for (const bad of [
    'http://gcwbndtxy.liveplay.myqcloud.com/gcwbnd/a.m3u8',
    'https://gcwbndtxy.liveplay.myqcloud.com.evil.test/a.m3u8',
    'https://user:pass@gcwbndali.v.myalicdn.com/a.m3u8',
    'https://gcwbndali.v.myalicdn.com:444/a.m3u8',
  ]) assert.throws(() => allowUrl(bad))
  assert.deepEqual(DYNAMIC_HOSTS.includes(CAMERA_HOST), true)
})

check('HLS 子资源受同一白名单限制，并按实际分辨率选择最高档', () => {
  const base = 'https://gcwbndali.v.myalicdn.com/gcwbnd/ipanda_2/index.m3u8'
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720', '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360', '360/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1350000,RESOLUTION=1024x576', '576/index.m3u8',
  ].join('\n')
  assert.equal(highestVariantUrl(master, base), 'https://gcwbndali.v.myalicdn.com/gcwbnd/ipanda_2/720/index.m3u8')
  assert.equal(validateHls(master, base), master)
  assert.equal(hasMediaSegment(master), false)
  assert.equal(hasMediaSegment('#EXTM3U\n#EXTINF:6,\nsegment.ts\n'), true)
  assert.equal(hasMediaSegment('#EXTM3U\n'), false)
  assert.throws(() => validateHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.test/key"\nseg.ts', base))
})

await checkAsync('首选 CDN 的最高档失败时回退官方线路，并缓存解析结果', async () => {
  const tencent = 'https://gcwbndtxy.liveplay.myqcloud.com/gcwbnd/ipanda_2/index.m3u8'
  const ali = 'https://gcwbndali.v.myalicdn.com/gcwbnd/ipanda_2/index.m3u8'
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720\n720.m3u8\n'
  let apiRequests = 0
  const fetchImpl = async raw => {
    const url = String(raw)
    if (url.startsWith(`https://${LIVE_API_HOST}/api2/liveHtml5.do?`)) {
      apiRequests++
      assert.match(url, /cctv_p2p_hdipanda/)
      return response(liveApi(tencent))
    }
    if (url === tencent || url === ali) return response(master)
    if (url === 'https://gcwbndtxy.liveplay.myqcloud.com/gcwbnd/ipanda_2/720.m3u8') {
      return response('temporarily unavailable', 502)
    }
    if (url === 'https://gcwbndali.v.myalicdn.com/gcwbnd/ipanda_2/720.m3u8') {
      return response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n')
    }
    throw new Error(`意外请求：${url}`)
  }
  const resolver = createResolver({ fetchImpl })
  const first = await resolver.resolve('ipanda-chengdu', { now: 1_700_000_000_000 })
  const second = await resolver.resolve('ipanda-chengdu', { now: 1_700_000_000_000 + STREAM_TTL_MS - 1 })
  assert.equal(apiRequests, 1)
  assert.equal(first.url, ali)
  assert.equal(second.url, ali)
  assert.equal(first.manifestText, master)
  assert.equal(first.manifestUrl, ali)
  assert.deepEqual(first.upstreamHeaders(`${ali}/../segment.ts`), {
    Referer: 'https://live.ipanda.com/xmcd/',
    Origin: 'https://live.ipanda.com',
  })
  assert.throws(() => first.upstreamUrlTransform('https://evil.test/segment.ts'))
})

await checkAsync('首选线路悬挂或返回空清单时，快速并发采用健康备用线路', async () => {
  const tencent = 'https://gcwbndtxy.liveplay.myqcloud.com/gcwbnd/ipanda_2/index.m3u8'
  const baidu = 'https://gcwbndbd.a.bdydns.com/gcwbnd/ipanda_2/index.m3u8'
  const ali = 'https://gcwbndali.v.myalicdn.com/gcwbnd/ipanda_2/index.m3u8'
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720\n720.m3u8\n'
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n'
  let loserAborted = false
  const fetchImpl = async (raw, init = {}) => {
    const url = String(raw)
    if (url.startsWith(`https://${LIVE_API_HOST}/api2/liveHtml5.do?`)) {
      return response(liveApi(tencent, { hls_url: { hls1: tencent, hls4: baidu, hls2: tencent } }))
    }
    if (url === tencent) {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          loserAborted = true
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }, { once: true })
      })
    }
    if (url === baidu) return response(master)
    if (url === 'https://gcwbndbd.a.bdydns.com/gcwbnd/ipanda_2/720.m3u8') return response('#EXTM3U\n')
    if (url === ali) return response(master)
    if (url === 'https://gcwbndali.v.myalicdn.com/gcwbnd/ipanda_2/720.m3u8') return response(media)
    throw new Error(`意外请求：${url}`)
  }
  const started = Date.now()
  const result = await createResolver({ fetchImpl }).resolve('ipanda-chengdu', { timeoutMs: 1_000 })
  assert.equal(result.url, ali)
  assert.ok(Date.now() - started < 500, '不应等待悬挂的首选线路超时后才尝试备用线路')
  assert.equal(loserAborted, true, '选出健康线路后应立即取消仍在悬挂的竞争请求')
})

await checkAsync('顶层直接为滚动媒体清单时只缓存 URL，不冻结清单正文', async () => {
  const ali = 'https://gcwbndali.v.myalicdn.com/gcwbnd/xiongmao23_2/index.m3u8'
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n'
  let mediaRequests = 0
  const fetchImpl = async raw => {
    const url = String(raw)
    if (url.startsWith(`https://${LIVE_API_HOST}/api2/liveHtml5.do?`)) return response(liveApi(ali))
    if (url === ali) { mediaRequests++; return response(media) }
    throw new Error(`意外请求：${url}`)
  }
  const resolver = createResolver({ fetchImpl })
  const first = await resolver.resolve('ipanda-jiangsu-dafeng-milu', { now: 1_700_000_000_000 })
  const second = await resolver.resolve('ipanda-jiangsu-dafeng-milu', { now: 1_700_000_000_001 })
  assert.equal(first.url, ali)
  assert.equal(first.manifestText, undefined)
  assert.equal(first.manifestUrl, ali)
  assert.equal(second.manifestText, undefined)
  assert.equal(mediaRequests, 1, '地址解析可以缓存，滚动正文必须留给 app 每轮重新获取')
})

await checkAsync('不安全重定向与上游错误只返回失败说明，不抛到请求处理器', async () => {
  const start = 'https://gcwbndtxy.liveplay.myqcloud.com/gcwbnd/a.m3u8'
  await assert.rejects(
    fetchText(start, {
      rules: DYNAMIC_HOSTS,
      fetchImpl: async () => response('', 302, { location: 'https://evil.test/a.m3u8' }),
    }),
    /不允许访问媒体地址/,
  )
  const resolver = createResolver({ fetchImpl: async () => response('upstream error', 500) })
  const failed = await resolver.resolve('ipanda-chengdu')
  assert.equal(failed.url, '')
  assert.match(failed.desc, /链接请求失败.*HTTP 500/)
  const malformed = await resolver.resolve('ipanda-unknown')
  assert.equal(malformed.url, '')
  assert.match(malformed.desc, /引用格式错误/)
})

console.log(`\n全部通过：${passed}/${passed} ✅`)
