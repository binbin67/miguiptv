/** 央视频：63 个公开频道匿名取流，10 个会员频道由官网浏览器解扰。 */
import { buildChannels, claimsRef } from './channels.js'
import { clearCache, resolveChannel } from './resolver.js'
import { browserLoginFlow, claimsLocalPath, handleLocalRequest, shutdown } from './runtime.js'

export default {
  id: 'yangshipin',
  name: '央视频',
  description: '63 个公开频道匿名取流，另含 10 个需登录/VIP 的频道；会员流由官网播放器自动解扰为 H.264。',
  category: 'account',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  // v2：在原有 63 个公开频道之外加入 10 个官网会员频道。递增后会让存量部署
  // 在启动生成播放列表前重建缓存，不必等待默认 24 小时刷新周期。
  catalogVersion: 2,
  outputGroupName: '央视频',
  // 公开频道分片必须由播放器直连 CDN，不能经本机转发：实测同一路频道，全代理下本机去拉分片被
  // 平台回 403，而清单直出（分片直连）与纯 302 两种方式都能稳定播放。差别只在「谁去拉分片」——
  // 播放器直连带着 TLS 会话复用与 keep-alive，本机代理则是每片一次裸请求，后者会被判成异常流量。
  // 用 relay 而非 302：清单仍由本机下发，不跟随跳转的播放器（issue #98 的极影视）照样能播。
  channelHlsMode: 'relay',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：公开频道播放时刷新短效地址并让分片直连 CDN；VIP 频道由本机官网浏览器持续解扰并输出兼容 HLS。',
  helper: 'yangshipin-login',
  configSchema: [],

  async fetch() {
    return { groups: [{ name: '央视频', dataList: buildChannels() }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
  browserLoginFlow,
  claimsLocalPath,
  handleLocalRequest,
  shutdown,
}
