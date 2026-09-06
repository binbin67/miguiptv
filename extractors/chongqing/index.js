/** 重庆广电：官网匿名频道目录，播放时自动换短效签名并全代理 HLS。 */
import {
  buildChannels,
  claimsRef,
  clearCache,
  fetchChannelList,
  resolveChannel,
} from './api.js'

export default {
  id: 'chongqing',
  name: '重庆',
  description: '重庆广电官网公开频道；无需登录，播放时自动换取匿名短效地址并中转加密 HLS。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  outputGroupName: '重庆',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道表每 240 分钟同步；播放签名短期复用，清单、AES 密钥和分片全代理。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    return {
      groups: [{ name: '重庆', dataList: buildChannels(rows) }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
