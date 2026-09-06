/** iPanda：22 路官网公开熊猫与珍稀动物直播。 */
import { clearCache, resolveChannel } from './api.js'
import { buildGroups, claimsRef, SOURCES } from './channels.js'

export default {
  id: 'ipanda',
  name: 'iPanda 官方直播',
  description: `iPanda 官网 ${SOURCES.length} 路公开直播；无需登录，最高 720p（官网标注“超清”）。`,
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: 'iPanda',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '频道表随模块版本更新；18 路固定机位直连，4 路动态频道播放时检查状态并自动切换官方 CDN。',
  configSchema: [],

  async fetch() {
    return { groups: buildGroups(), meta: { skipped: [], warnings: [] } }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
