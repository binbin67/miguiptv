/** 安徽广电：「安徽视讯」App 公开的七路电视频道，播放时按 App 算法签名并以 App 标识全代理。 */
import {
  buildChannels,
  claimsRef,
  clearCache,
  resolveChannel,
} from './api.js'

export default {
  id: 'anhui',
  name: '安徽',
  description: '安徽视讯 App 公开的 7 路电视频道；无需登录，播放时按 App 公开算法生成短效签名，清单与分片由本机以 App 播放器标识全代理。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '安徽',
  // CDN 按播放器标识放行，VLC / Apple / ExoPlayer 等常见播放器直连一律 403，只能全代理。
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：固定频道表随模块版本更新；播放时刷新 App 鉴权密钥与两小时签名，播放器每次轮询都重新拉取滚动清单，清单与分片均以 App 播放器标识经本机代理。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '安徽', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
