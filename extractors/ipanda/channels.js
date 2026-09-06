/** iPanda 官网公开直播目录：18 路固定机位 + 4 路动态频道。 */

export const IPANDA_GROUP = 'iPanda'
export const IPANDA_LOGO = 'https://p2.img.cctvpic.com/photoAlbum/templet/common/TPTEjtwxdE0E0hk2XE4yFM3D230723/top_H5_logo.png'
// 固定机位使用官网 Ali 镜像：它的清单和分片都带 ACAO:*，可由网页播放器直连。
// WSC 镜像没有 CORS 响应头，只放在动态频道的服务端代理候选中。
export const CAMERA_HOST = 'gcwbndali.v.myalicdn.com'

const rows = [
  { id: 'chengdu', name: '成都基地 24小时', page: 'https://live.ipanda.com/xmcd/', channel: 'ipanda', dynamic: true, kind: '动态总频道' },
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
  { id: 'dujiangyan', name: '都江堰 24小时', page: 'https://live.ipanda.com/xmwl/index.shtml', channel: 'ipanda1000', dynamic: true, kind: '动态总频道' },
  { id: 'dujiangyan-jifu-a', name: '都江堰·吉福A', page: 'https://live.ipanda.com/xmwl/01/index.shtml', channel: 'xiongmao11' },
  { id: 'dujiangyan-ruixi-qiaoyi-a', name: '都江堰·瑞喜、乔怡A', page: 'https://live.ipanda.com/xmwl/02/index.shtml', channel: 'xiongmao12' },
  { id: 'dujiangyan-xinqiao', name: '都江堰·新乔', page: 'https://live.ipanda.com/xmwl/03/index.shtml', channel: 'xiongmao13' },
  { id: 'dujiangyan-qingling', name: '都江堰·青灵', page: 'https://live.ipanda.com/xmwl/04/index.shtml', channel: 'xiongmao14' },
  { id: 'dujiangyan-youyou', name: '都江堰·优悠', page: 'https://live.ipanda.com/xmwl/05/index.shtml', channel: 'xiongmao15' },
  { id: 'dujiangyan-ruixi-qiaoyi-b', name: '都江堰·瑞喜、乔怡B', page: 'https://live.ipanda.com/xmwl/06/index.shtml', channel: 'xiongmao16' },
  { id: 'dujiangyan-jifu-b', name: '都江堰·吉福B', page: 'https://live.ipanda.com/xmwl/08/index.shtml', channel: 'xiongmao18' },
  { id: 'dujiangyan-chunye-qiuye', name: '都江堰·春野、秋野', page: 'https://live.ipanda.com/xmwl/11/index.shtml', channel: 'xiongmao20' },
  { id: 'jiangsu-dafeng-milu', name: '江苏大丰麋鹿国家级自然保护区', page: 'https://live.ipanda.com/zxwz/milu/index.shtml', channel: 'xiongmao23', dynamic: true, kind: '珍稀动物直播' },
  { id: 'yunnan-baima-snow-mountain', name: '云南白马雪山自然保护区', page: 'https://live.ipanda.com/zxwz/bmxs/index.shtml', channel: 'xiongmao24', dynamic: true, kind: '珍稀动物直播' },
]

export const SOURCES = Object.freeze(rows.map(row => Object.freeze({ ...row })))
const DYNAMIC_BY_REF = new Map(
  SOURCES.filter(source => source.dynamic).map(source => [`ipanda-${source.id}`, source]),
)

export function fixedStreamUrl(channel) {
  return `https://${CAMERA_HOST}/gcwbnd/${channel}_2/index.m3u8`
}

export function sourceFromRef(ref) {
  return DYNAMIC_BY_REF.get(String(ref || ''))
}

export function claimsRef(ref) {
  return DYNAMIC_BY_REF.has(String(ref || ''))
}

export function buildGroups() {
  const dataList = SOURCES.map(source => ({
    name: source.name,
    ...(source.dynamic
      ? { deferredRef: `ipanda-${source.id}`, proxyHls: true }
      : { url: fixedStreamUrl(source.channel) }),
    logo: IPANDA_LOGO,
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
  return [{ name: IPANDA_GROUP, dataList }]
}
