#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  ANNOUNCEMENT, ANNOUNCEMENT_CHANNEL_KEY, FROM_THE_WEB_GUIDE, SYSTEM_CHANNELS, SYSTEM_CHANNEL_KEYS, YSP_LOGIN_GUIDE,
  announcementM3uEntry, announcementTxtEntry, isAnnouncementChannel,
  protectAnnouncementConfig, readAnnouncementAsset, systemChannelByUrl, systemChannelKey,
} from '../utils/announcement.js'
import { applyConfig } from '../utils/playlistConfig.js'

console.log('公告频道测试')

assert.equal(ANNOUNCEMENT.name, '欢迎使用 iPTV for iFansClub.com')
assert.equal(YSP_LOGIN_GUIDE.name, '央视频会员频道登录教程')
assert.equal(FROM_THE_WEB_GUIDE.name, '「来源于网络」频道添加教程')
assert.deepEqual(SYSTEM_CHANNELS.map(channel => channel.tvgId), ['iptv-announcement', 'iptv-ysp-login-guide', 'iptv-from-the-web-guide'])
assert.deepEqual(SYSTEM_CHANNEL_KEYS, ['公告::iptv-announcement', '公告::iptv-ysp-login-guide', '公告::iptv-from-the-web-guide'])
assert.equal(ANNOUNCEMENT_CHANNEL_KEY, systemChannelKey(ANNOUNCEMENT))

// 三条系统频道都写进播放列表，公告在前、两条教程按声明顺序在后，同一分组
const m3u = announcementM3uEntry()
assert.match(m3u, /group-title="公告",欢迎使用 iPTV for iFansClub\.com/)
assert.match(m3u, /tvg-id="iptv-ysp-login-guide" tvg-name="央视频会员频道登录教程" tvg-logo="\$\{replace\}\/assets\/ysp-login-guide-logo\.png" group-title="公告",央视频会员频道登录教程/)
assert.match(m3u, /tvg-id="iptv-from-the-web-guide" tvg-name="「来源于网络」频道添加教程" tvg-logo="\$\{replace\}\/assets\/from-the-web-guide-logo\.png" group-title="公告",「来源于网络」频道添加教程/)
assert.ok(m3u.indexOf('announcement.mp4') < m3u.indexOf('ysp-login-guide.mp4'))
assert.ok(m3u.indexOf('ysp-login-guide.mp4') < m3u.indexOf('from-the-web-guide.mp4'))
assert.equal((m3u.match(/#EXTINF/g) || []).length, 3)

const txt = announcementTxtEntry()
assert.equal(txt, `公告,#genre#\n欢迎使用 iPTV for iFansClub.com,\${replace}/assets/announcement.mp4\n央视频会员频道登录教程,\${replace}/assets/ysp-login-guide.mp4\n「来源于网络」频道添加教程,\${replace}/assets/from-the-web-guide.mp4\n`)

assert.equal(systemChannelByUrl('${replace}/assets/ysp-login-guide.mp4'), YSP_LOGIN_GUIDE)
assert.equal(systemChannelByUrl('${replace}/assets/from-the-web-guide.mp4'), FROM_THE_WEB_GUIDE)
assert.equal(systemChannelByUrl('${replace}/assets/other.mp4'), null)
assert.equal(isAnnouncementChannel({ id: 'iptv-ysp-login-guide' }), true)
assert.equal(isAnnouncementChannel({ url: '${replace}/assets/announcement.mp4' }), true)
assert.equal(isAnnouncementChannel({ id: 'c1' }), false)

// 三条短片都必须是 1080p、faststart 的 H.264 mp4，台标 512×512 PNG
for (const channel of SYSTEM_CHANNELS) {
  const video = readAnnouncementAsset(channel.videoPath)
  const logo = readAnnouncementAsset(channel.logoPath)
  assert.equal(video?.contentType, 'video/mp4', channel.name)
  assert.equal(video?.content.subarray(4, 8).toString('ascii'), 'ftyp', channel.name)
  const videoBytes = video.content
  const moovOffset = videoBytes.indexOf(Buffer.from('moov'))
  const mdatOffset = videoBytes.indexOf(Buffer.from('mdat'))
  assert.ok(moovOffset > 0 && moovOffset < mdatOffset, `${channel.name} 视频应启用 faststart`)
  const tkhdOffset = videoBytes.indexOf(Buffer.from('tkhd')) - 4
  assert.ok(tkhdOffset >= 0, `${channel.name} 视频应包含视频轨道`)
  const tkhdVersion = videoBytes[tkhdOffset + 8]
  const dimensionsOffset = tkhdOffset + (tkhdVersion === 1 ? 96 : 84)
  assert.equal(videoBytes.readUInt32BE(dimensionsOffset) / 65536, 1920, channel.name)
  assert.equal(videoBytes.readUInt32BE(dimensionsOffset + 4) / 65536, 1080, channel.name)
  assert.equal(logo?.contentType, 'image/png', channel.name)
  assert.deepEqual([...logo.content.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], channel.name)
  assert.equal(logo.content.readUInt32BE(16), 512, channel.name)
  assert.equal(logo.content.readUInt32BE(20), 512, channel.name)
}
assert.equal(readAnnouncementAsset('/assets/nope.mp4'), null)

const GUIDE_KEY = systemChannelKey(YSP_LOGIN_GUIDE)
const WEB_GUIDE_KEY = systemChannelKey(FROM_THE_WEB_GUIDE)
const protectedConfig = protectAnnouncementConfig({
  hiddenChannels: [ANNOUNCEMENT_CHANNEL_KEY, GUIDE_KEY, '央视::c1'],
  deletedGroups: ['公告', '公*', '影视'],
  groupOrder: ['体育', '公告', '央视'],
  channelGroupMap: { [ANNOUNCEMENT_CHANNEL_KEY]: '影视', [GUIDE_KEY]: '影视', [WEB_GUIDE_KEY]: '影视', '央视::c1': '收藏' },
  channelRenameMap: { [ANNOUNCEMENT_CHANNEL_KEY]: '别删我', [GUIDE_KEY]: '改名', [WEB_GUIDE_KEY]: '改名' },
  channelOrder: { 公告: [WEB_GUIDE_KEY, GUIDE_KEY, ANNOUNCEMENT_CHANNEL_KEY], 央视: ['央视::c1'] },
  groupRenameMap: { 公告: '别的名字', 央视: '中央台' },
  groupSortMode: { 公告: 'name', 央视: 'name' },
})
// 隐藏放行（issue #119）：两条系统频道都可隐藏，其余保护项不变
assert.deepEqual(protectedConfig.hiddenChannels, [ANNOUNCEMENT_CHANNEL_KEY, GUIDE_KEY, '央视::c1'])
assert.deepEqual(protectedConfig.deletedGroups, ['公*', '影视'])
assert.deepEqual(protectedConfig.groupOrder, ['公告', '体育', '央视'])
assert.equal(protectedConfig.channelGroupMap[ANNOUNCEMENT_CHANNEL_KEY], undefined)
assert.equal(protectedConfig.channelGroupMap[GUIDE_KEY], undefined)
assert.equal(protectedConfig.channelGroupMap[WEB_GUIDE_KEY], undefined)
assert.equal(protectedConfig.channelRenameMap[ANNOUNCEMENT_CHANNEL_KEY], undefined)
assert.equal(protectedConfig.channelRenameMap[GUIDE_KEY], undefined)
assert.equal(protectedConfig.channelRenameMap[WEB_GUIDE_KEY], undefined)
assert.equal(protectedConfig.channelOrder.公告, undefined)
assert.equal(protectedConfig.groupRenameMap.公告, undefined)
assert.equal(protectedConfig.groupSortMode.公告, undefined)
assert.equal(protectedConfig.channelGroupMap['央视::c1'], '收藏')

const systemRows = () => SYSTEM_CHANNELS.map(channel => ({
  id: channel.tvgId, name: channel.name, tvgId: channel.tvgId, tvgName: channel.name, originalGroup: '公告', url: `\${replace}${channel.videoPath}`,
}))
const sampleGroups = () => [
  { name: '央视', channels: [{ id: 'c1', name: 'CCTV1', tvgId: 'CCTV1', tvgName: 'CCTV1', originalGroup: '央视' }] },
  { name: '公告', channels: systemRows() },
]
const hostileConfig = () => ({
  hiddenChannels: [],
  deletedGroups: ['公*'],
  groupOrder: ['央视', '公告'],
  channelGroupMap: { [ANNOUNCEMENT_CHANNEL_KEY]: '央视', [GUIDE_KEY]: '央视', [WEB_GUIDE_KEY]: '央视' },
  channelRenameMap: { [ANNOUNCEMENT_CHANNEL_KEY]: '伪公告', [GUIDE_KEY]: '伪教程', [WEB_GUIDE_KEY]: '伪教程2' },
  channelOrder: { 公告: [WEB_GUIDE_KEY, GUIDE_KEY, ANNOUNCEMENT_CHANNEL_KEY] }, groupRenameMap: { 公告: '其它' }, groupSortMode: {}, customGroups: [],
})

// 删除 / 移动 / 重命名 / 改序全部无效：公告分组仍在首位，三条短片按声明顺序、原名输出
const forced = applyConfig(sampleGroups(), hostileConfig())
assert.equal(forced[0].name, ANNOUNCEMENT.group)
assert.deepEqual(forced[0].channels.map(channel => channel.name), [ANNOUNCEMENT.name, YSP_LOGIN_GUIDE.name, FROM_THE_WEB_GUIDE.name])

// 隐藏是唯一放行的操作（issue #119），且逐条独立：藏掉两条教程，公告照常置顶
const guideHidden = applyConfig(sampleGroups(), { ...hostileConfig(), hiddenChannels: [GUIDE_KEY, WEB_GUIDE_KEY] })
assert.deepEqual(guideHidden[0].channels.map(channel => channel.id), [ANNOUNCEMENT.tvgId])
// 只藏中间那条，前后两条保持声明顺序
const middleHidden = applyConfig(sampleGroups(), { ...hostileConfig(), hiddenChannels: [GUIDE_KEY] })
assert.deepEqual(middleHidden[0].channels.map(channel => channel.id), [ANNOUNCEMENT.tvgId, FROM_THE_WEB_GUIDE.tvgId])
// 三条都藏掉，公告分组整个不出现，其它分组不受影响
const hidden = applyConfig(sampleGroups(), { ...hostileConfig(), hiddenChannels: [ANNOUNCEMENT_CHANNEL_KEY, GUIDE_KEY, WEB_GUIDE_KEY] })
assert.equal(hidden.some(group => group.name === ANNOUNCEMENT.group), false)
assert.deepEqual(hidden.map(group => group.name), ['央视'])

console.log('全部通过：公告条目、视频与台标资源有效 ✅')
