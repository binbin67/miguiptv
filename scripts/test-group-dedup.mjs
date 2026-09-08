#!/usr/bin/env node
/**
 * 分组判重回归测试（issue #35 / 邮件反馈「自定义分组只能加一个」）
 *
 * 验证：被「移空 / 隐藏 / 删除」而在「我的频道」列表里看不到的分组，不再占用其分组名，
 * 因此可以把别的分组改名成它、或新建同名分组；但同名分组若「当前可见」仍会被拦截。
 * G/H 另外守住：早先合法建下、后来才被源变化撞上的旧冲突，不能把后续分组操作整个锁死。
 *
 * 运行： node scripts/test-group-dedup.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { validateGroupConfig, collectGroupConflicts, applyConfig } from '../utils/playlistConfig.js'

// 静音 applyConfig 里的彩色业务日志（printBlue/printGreen 经 console.log，消息在末位参数），让测试输出清爽
for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => {
    if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成/.test(x))) return
    orig.apply(console, a)
  }
}

// 订阅源原始分组（相当于 parseInterfaceTxt() 的返回）
const sourceGroups = () => ([
  { name: '央视', channels: [{ id: 'cctv1', name: 'CCTV1' }, { id: 'cctv2', name: 'CCTV2' }] },
  { name: '卫视', channels: [{ id: 'hunan', name: '湖南卫视' }] },
])
const baseConfig = () => ({
  channelGroupMap: {}, channelRenameMap: {}, channelOrder: {}, hiddenChannels: [],
  customGroups: [], groupOrder: [], deletedGroups: [], groupRenameMap: {}, groupSortMode: {},
})
const visibleNames = (groups, config) => applyConfig(groups, config).map(g => g.name)

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ✅ ${name}`)
}

console.log('分组判重回归测试 (issue #35)')

// A. 频道被全部移进自定义组「组团一」→ 央视变空壳不可见 → 把「组团一」改名为「央视」应放行
check('A 频道移走后，改名/复用空壳分组名 → 放行', () => {
  const groups = sourceGroups()

  // 前置状态：把央视两条频道都移进自定义组「组团一」，此时央视已不可见
  const before = baseConfig()
  before.customGroups = [{ name: '组团一' }]
  before.channelGroupMap = { '央视::cctv1': '组团一', '央视::cctv2': '组团一' }
  assert.equal(visibleNames(groups, before).includes('央视'), false, '改名前央视应不可见')

  // 把「组团一」改名为「央视」（自定义组改名 = customGroups 改名 + channelGroupMap 重映射）
  const after = baseConfig()
  after.customGroups = [{ name: '央视' }]
  after.channelGroupMap = { '央视::cctv1': '央视', '央视::cctv2': '央视' }
  assert.deepEqual(validateGroupConfig(groups, after), { valid: true })

  // 合并结果正确：央视下应有 CCTV1、CCTV2
  const yangshi = applyConfig(groups, after).find(g => g.name === '央视')
  assert.deepEqual(yangshi.channels.map(c => c.name), ['CCTV1', 'CCTV2'])
  // 关键：空壳/隐藏分组的名字未被改写
  assert.equal(groups[0].name, '央视')
  assert.deepEqual(after.groupRenameMap, {})
})

// B. 整组删除央视后，新建自定义组「央视」应放行
check('B 整组删除后，新建同名分组 → 放行', () => {
  const groups = sourceGroups()
  const cfg = baseConfig()
  cfg.deletedGroups = ['央视']
  cfg.customGroups = [{ name: '央视' }]
  assert.deepEqual(validateGroupConfig(groups, cfg), { valid: true })
})

// C. 央视「当前可见」时，把「卫视」改名为「央视」应仍然拦截（保留既有防线）
check('C 同名分组当前可见 → 仍拦截', () => {
  const groups = sourceGroups()
  const cfg = baseConfig()
  cfg.groupRenameMap = { '卫视': '央视' }
  const r = validateGroupConfig(groups, cfg)
  assert.equal(r.valid, false)
  assert.match(r.message, /央视.*已存在/)
})

// D. 央视频道被「隐藏」（非移动）后，把别的组改名为「央视」应放行
check('D 频道被隐藏后，复用其分组名 → 放行', () => {
  const groups = sourceGroups()
  const cfg = baseConfig()
  cfg.hiddenChannels = ['央视::cctv1', '央视::cctv2']
  cfg.customGroups = [{ name: '央视' }]
  assert.equal(visibleNames(groups, cfg).includes('央视'), true, '此处央视是新建自定义空组，应可见')
  assert.deepEqual(validateGroupConfig(groups, cfg), { valid: true })
})

// E. 防回归：两个都「可见」的不同分组重命名到同一个名字 → 拦截
check('E 两个可见分组撞名 → 拦截', () => {
  const groups = sourceGroups()
  const cfg = baseConfig()
  cfg.groupRenameMap = { '央视': '合集', '卫视': '合集' }
  assert.equal(validateGroupConfig(groups, cfg).valid, false)
})

// F. 防回归：「未分组」不允许被重命名
check('F 未分组不允许重命名 → 拦截', () => {
  const groups = sourceGroups()
  const cfg = baseConfig()
  cfg.groupRenameMap = { '未分组': '其它' }
  assert.equal(validateGroupConfig(groups, cfg).valid, false)
})

// G. 建组时源里没有「浙江」组（源抓取失败 / 该组被隐藏），之后源恢复 → 旧冲突不该锁死新增分组
//    这正是邮件反馈「分组只能添加一个，再添加就提示前面那个添加的名字」的成因
check('G 旧冲突不锁死后续新增分组 → 放行，且不误报旧组名', () => {
  const groupsBefore = sourceGroups()                       // 源里此时没有「浙江」
  const before = baseConfig()
  before.customGroups = [{ name: '浙江' }]
  assert.deepEqual(validateGroupConfig(groupsBefore, before), { valid: true }, '建「浙江」时应放行')

  // 源恢复后 interface.txt 里又有「浙江」组了，用户这次要加的是「体育台」
  const groupsAfter = [...sourceGroups(), { name: '浙江', channels: [{ id: 'zj1', name: '浙江卫视' }] }]
  const after = baseConfig()
  after.customGroups = [{ name: '浙江' }, { name: '体育台' }]

  const existing = new Set(collectGroupConflicts(groupsAfter, before).map(item => item.name))
  const introduced = collectGroupConflicts(groupsAfter, after).filter(item => !existing.has(item.name))
  assert.deepEqual(existing, new Set(['浙江']), '旧配置本身已经撞名')
  assert.deepEqual(introduced, [], '本次只加了「体育台」，不该被旧冲突拦下')

  // 界面上两者合并为一个「浙江」，用户看不到重名，所以更不能拿它当拦截理由
  assert.equal(applyConfig(groupsAfter, after).filter(g => g.name === '浙江').length, 1)
})

// H. 同一状态下若真去新建一个当前可见的同名分组，仍要拦，且报错指向本次这个名字
check('H 旧冲突存在时，新引入的重名照拦且报错指对组', () => {
  const groups = [...sourceGroups(), { name: '浙江', channels: [{ id: 'zj1', name: '浙江卫视' }] }]
  const before = baseConfig()
  before.customGroups = [{ name: '浙江' }]
  const after = baseConfig()
  after.customGroups = [{ name: '浙江' }, { name: '央视' }]   // 央视当前可见 → 真重名

  const existing = new Set(collectGroupConflicts(groups, before).map(item => item.name))
  const introduced = collectGroupConflicts(groups, after).filter(item => !existing.has(item.name))
  assert.equal(introduced.length, 1)
  assert.match(introduced[0].message, /央视.*已存在/)
})

console.log(`\n全部通过：${passed}/8 ✅`)
