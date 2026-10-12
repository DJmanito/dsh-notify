// dsh-notify 运行集合判定逻辑单测(纯 node,无依赖)
// 场景覆盖:主代理/子代理/多级子代理/fork 会话 的完成边沿语义
import assert from 'node:assert/strict'
import { isSubagentHeader, topRootOf, computeRunningSet, readEvents, buildToastXml, escapeXml, classifyPageUa, buildToastScripts, resolveSessionTitle, shortSid, selfCompactState, lineageSids, gateConfigFromEnv } from '../lib/index.js'

const H = (id, extra) => ({ id, ...extra })
const map = (list) => new Map(list.map((h) => [h.id, h]))
const agents = (list) => list.map(([id, status = 'running', header]) => ({ id, status, header }))

let passed = 0
function t(name, fn) {
  fn()
  passed++
  console.log('  ✓', name)
}

console.log('isSubagentHeader')
t('origin=subagent → 子代理', () => assert.equal(isSubagentHeader(H('a', { origin: 'subagent' })), true))
t('delegationDepth>0 → 子代理', () => assert.equal(isSubagentHeader(H('a', { delegationDepth: 2 })), true))
t('无标记 → 主会话', () => assert.equal(isSubagentHeader(H('a')), false))
t('对话 fork(仅 parentSession+isSeeded)→ 主会话', () =>
  assert.equal(isSubagentHeader(H('a', { parentSession: 'main', isSeeded: true })), false))

console.log('topRootOf')
{
  const hdr = map([
    H('main'),
    H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' }),
    H('sub2', { origin: 'subagent', delegationDepth: 2, parentSession: 'sub1' }),
  ])
  t('深度1 → 父即顶层', () => assert.equal(topRootOf('sub1', hdr), 'main'))
  t('深度2 → 爬到顶层', () => assert.equal(topRootOf('sub2', hdr), 'main'))
  t('主会话 → 自身', () => assert.equal(topRootOf('main', hdr), 'main'))
  t('父离线(depth=1 语义兜底)→ 仍归顶层', () =>
    assert.equal(topRootOf('sub1', map([H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' })])), 'main'))
  t('父离线且深度未知 → null(不归属)', () => {
    const h2 = map([H('x', { origin: 'subagent', parentSession: 'ghost' })])
    assert.equal(topRootOf('x', h2), null)
  })
}

console.log('computeRunningSet(完成边沿语义)')
{
  const hdr = map([
    H('main'),
    H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' }),
    H('sub2', { origin: 'subagent', delegationDepth: 2, parentSession: 'sub1' }),
    H('fork1', { parentSession: 'main', isSeeded: true }),
  ])
  t('主运行、无子代理 → {main}', () =>
    assert.deepEqual(computeRunningSet(agents([['main', 'running', H('main')]]), hdr), ['main']))
  t('主运行 + 子代理运行 → {main}(去重)', () =>
    assert.deepEqual(computeRunningSet(agents([['main', 'running', H('main')], ['sub1', 'running', H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' })]]), hdr), ['main']))
  t('★ 主已结束、子代理运行 → {main}(不发完成通知)', () =>
    assert.deepEqual(computeRunningSet(agents([['main', 'idle', H('main')], ['sub1', 'running', H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' })]]), hdr), ['main']))
  t('★ 主已结束、子代理也结束 → [](边沿触发完成通知)', () =>
    assert.deepEqual(computeRunningSet(agents([['main', 'idle', H('main')], ['sub1', 'idle', H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' })]]), hdr), []))
  t('主运行、子代理已结束 → {main}', () =>
    assert.deepEqual(computeRunningSet(agents([['main', 'running', H('main')], ['sub1', 'idle', H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' })]]), hdr), ['main']))
  t('主已结束、深度2孙代理运行(中间层活跃) → {main}', () =>
    assert.deepEqual(computeRunningSet(agents([['main', 'idle', H('main')], ['sub1', 'idle', H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' })], ['sub2', 'running', H('sub2', { origin: 'subagent', delegationDepth: 2, parentSession: 'sub1' })]]), hdr), ['main']))
  t('两个主会话互不干扰(A 有子代理运行,B 空闲 → 只 {A})', () => {
    const h2 = map([H('A'), H('B'), H('Asub', { origin: 'subagent', delegationDepth: 1, parentSession: 'A' })])
    assert.deepEqual(computeRunningSet(agents([['A', 'idle', H('A')], ['B', 'idle', H('B')], ['Asub', 'running', H('Asub', { origin: 'subagent', delegationDepth: 1, parentSession: 'A' })]]), h2), ['A'])
  })
  t('子代理会话自身 id 不进入集合(完成不直接通知)', () =>
    assert.deepEqual(computeRunningSet(agents([['sub1', 'running', H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' })]]), hdr), ['main']))
  t('fork 运行 → 按顶层会话计入 {fork1}', () =>
    assert.deepEqual(computeRunningSet(agents([['fork1', 'running', H('fork1', { parentSession: 'main', isSeeded: true })]]), hdr), ['fork1']))
  t('header 缺失时回落 headerById', () =>
    assert.deepEqual(computeRunningSet(agents([['sub1', 'running', undefined]]), hdr), ['main']))
  t('主离线、子代理运行且父离线(depth=1) → 仍归顶层 {main}', () => {
    const h2 = map([H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' })])
    assert.deepEqual(computeRunningSet(agents([['sub1', 'running', H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' })]]), h2), ['main'])
  })
}

console.log('readEvents(新旧 Session 双通道)')
{
  const evs = [{ type: 'a' }, { type: 'b' }]
  t('新版:snapshotEvents()', () => assert.deepEqual(readEvents({ snapshotEvents: () => evs }), evs))
  t('旧版:session.events', () => assert.deepEqual(readEvents({ events: evs }), evs))
  t('snapshotEvents 抛错 → 回落 events', () =>
    assert.deepEqual(readEvents({ snapshotEvents: () => { throw new Error('x') }, events: evs }), evs))
  t('都没有 → []', () => assert.deepEqual(readEvents({}), []))
}

console.log('buildToastXml(Windows toast XML)')
{
  t('基本结构:ToastText02 + 音频', () => {
    const x = buildToastXml('⏳ DSH 会话等待审批', '会话A')
    assert.ok(x.startsWith('<toast>'))
    assert.ok(x.includes('<audio silent="false" />'))
    assert.ok(x.includes('template="ToastText02"'))
    assert.ok(x.includes('<text id="1">⏳ DSH 会话等待审批</text>'))
    assert.ok(x.includes('<text id="2">会话A</text>'))
  })
  t('XML 特殊字符转义', () => {
    const x = buildToastXml('A & B <C> "D" \'E\'', 'body')
    assert.ok(x.includes('A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;'))
  })
  t('超长截断(标题100/正文200)', () => {
    const x = buildToastXml('x'.repeat(300), 'y'.repeat(300))
    const m1 = x.match(/<text id="1">([^<]*)<\/text>/)
    const m2 = x.match(/<text id="2">([^<]*)<\/text>/)
    assert.equal(m1[1].length, 100)
    assert.equal(m2[1].length, 200)
  })
  t('空值不崩', () => {
    const x = buildToastXml(null, undefined)
    assert.ok(x.includes('<text id="1"></text>'))
  })
  t('escapeXml 纯转义', () => assert.equal(escapeXml('<a b="c">&\''), '&lt;a b=&quot;c&quot;&gt;&amp;&apos;'))
}

console.log('classifyPageUa(设置归因)')
{
  t('手机 App WebView(DshNotify)→ phone', () =>
    assert.equal(classifyPageUa('Mozilla/5.0 (Linux) DshNotify/1.0'), 'phone'))
  t('DSH 桌面壳(Electron)→ desktop-shell', () =>
    assert.equal(classifyPageUa('Mozilla/5.0 Chrome/120 Electron/28.0'), 'desktop-shell'))
  t('Chrome 浏览器 → browser', () =>
    assert.equal(classifyPageUa('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36'), 'browser'))
  t('Firefox → browser', () =>
    assert.equal(classifyPageUa('Mozilla/5.0 Firefox/121.0'), 'browser'))
  t('Edge(含 Edge 标记)→ browser', () =>
    assert.equal(classifyPageUa('Mozilla/5.0 Edg/120.0'), 'browser'))
  t('PowerShell/curl 探测 → other', () =>
    assert.equal(classifyPageUa('Mozilla/5.0 (compatible; PowerShell/7.4)'), 'other'))
  t('空 UA → unknown', () => assert.equal(classifyPageUa(''), 'unknown'))
}

console.log('buildToastScripts(WinRT spawn 双脚本 + broker 回退)')
{
  t('父脚本包含直发 + 0x80073D54 判定 + WMI broker 回退', () => {
    const { parentRaw } = buildToastScripts('T', 'B')
    assert.ok(parentRaw.includes('CreateToastNotifier'))
    assert.ok(parentRaw.includes('0x80073D54'))
    assert.ok(parentRaw.includes('Win32_Process'))
    assert.ok(parentRaw.includes('CommandLine'))
    assert.ok(parentRaw.includes('exit 4')) // broker 被拒 → 4
  })
  t('父脚本把孙脚本以 -EncodedCommand base64 注入(无嵌套引号)', () => {
    const { parentRaw } = buildToastScripts('T', 'B')
    assert.ok(parentRaw.includes('-EncodedCommand '))
    // 注入的 base64 段应为纯 base64(不含单/双引号、空格)
    const m = parentRaw.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)
    assert.ok(m, '未找到 -EncodedCommand <b64>')
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(m[1]))
  })
  t('孙脚本独立可发(直发,无 broker)', () => {
    const { gcRaw } = buildToastScripts('T', 'B')
    assert.ok(gcRaw.includes('CreateToastNotifier'))
    assert.ok(gcRaw.includes('exit 0'))
    assert.ok(!gcRaw.includes('Win32_Process'), '孙脚本不应再套 broker')
  })
  t('base64 往返:parentB64/gcB64 可还原出对应 raw', () => {
    const { parentB64, gcB64, parentRaw, gcRaw } = buildToastScripts('T', 'B')
    assert.equal(Buffer.from(parentB64, 'base64').toString('utf16le'), parentRaw)
    assert.equal(Buffer.from(gcB64, 'base64').toString('utf16le'), gcRaw)
  })
  t('XML 特殊字符正确嵌入 PS 单引号串(escapeXml 后再 psq)', () => {
    const { parentRaw, gcRaw } = buildToastScripts('A & B <C> "D" \'E\'', 'body')
    const expected = "A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;"
    for (const raw of [parentRaw, gcRaw]) {
      const line = raw.split('\n').find((l) => l.startsWith('$x.LoadXml('))
      assert.ok(line, '缺少 LoadXml 行')
      assert.ok(line.startsWith("$x.LoadXml('"), 'LoadXml 参数应为单引号串')
      assert.ok(line.endsWith("')"), 'LoadXml 行应以 \') 收尾')
      assert.ok(line.includes(expected), '转义后的标题未嵌入: ' + line.slice(0, 120))
    }
  })
  t('默认候选列表:首选 DSH 通知,回落 DshNotify', () => {
    const { gcRaw } = buildToastScripts('T', 'B')
    assert.ok(gcRaw.includes('@(\'DSH 通知\', \'DshNotify\')'), '候选列表未嵌入: ' + (gcRaw.match(/foreach \(\$a in @[^\)]*\)/)?.[0]))
  })
  t('自定义 aumid(单值/列表)生效', () => {
    const single = buildToastScripts('T', 'B', 'X.Custom')
    assert.ok(single.gcRaw.includes('@(\'X.Custom\')'))
    const multi = buildToastScripts('T', 'B', ['A.One', 'B.Two'])
    assert.ok(multi.gcRaw.includes('@(\'A.One\', \'B.Two\')'))
  })
}

console.log('resolveSessionTitle(标题多源回落:同步→缓存→顶层)')
{
  const hdr = map([
    H('main'),
    H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' }),
  ])
  t('会话对象自带 title(同步源,零竞态)', () => {
    const s = new Map([['main', { id: 'main', title: '  我的任务  ' }]])
    assert.equal(resolveSessionTitle('main', s, new Map(), hdr), '我的任务')
  })
  t('header.title 也认', () => {
    const s = new Map([['main', { id: 'main', header: { title: '头部标题' } }]])
    assert.equal(resolveSessionTitle('main', s, new Map(), hdr), '头部标题')
  })
  t('对象无 title → 回落 titleCache(异步读结果)', () => {
    const s = new Map([['main', { id: 'main' }]])
    const cache = new Map([['main', '缓存标题']])
    assert.equal(resolveSessionTitle('main', s, cache, hdr), '缓存标题')
  })
  t('子会话无自身标题 → 取顶层会话标题(子代理归属)', () => {
    const s = new Map([
      ['main', { id: 'main', title: '主会话标题' }],
      ['sub1', { id: 'sub1', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'main' } }],
    ])
    assert.equal(resolveSessionTitle('sub1', s, new Map(), hdr), '主会话标题')
  })
  t('子会话自身有标题 → 优先自身', () => {
    const s = new Map([
      ['main', { id: 'main', title: '主会话标题' }],
      ['sub1', { id: 'sub1', title: '子会话标题', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'main' } }],
    ])
    assert.equal(resolveSessionTitle('sub1', s, new Map(), hdr), '子会话标题')
  })
  t('三源皆空 → 空串(由调用方决定回落)', () => {
    assert.equal(resolveSessionTitle('ghost', new Map(), new Map(), hdr), '')
  })
  t('shortSid:去 session- 前缀取前 8 位', () => {
    assert.equal(shortSid('session-2514b418-382c-4896-abcdef'), '会话 2514b418')
    assert.equal(shortSid('no-prefix-1234567890'), '会话 no-prefi')
  })
}

console.log('selfCompactState(自助压缩登记状态:事件流痕迹判定)')
{
  const req = () => ({ type: 'tool/call', data: { callId: 'c1', name: 'request_compact', arguments: {} } })
  const start = () => ({ type: 'compaction/start', data: {} })
  const end = () => ({ type: 'compaction/end', data: {} })
  const wake = () => ({ type: 'user/message', data: { role: 'user', source: { kind: 'plugin:hybrid-idle-compactor', form: 'notice' } } })
  t('空流 → none', () => assert.equal(selfCompactState([]), 'none'))
  t('无登记 → none', () => assert.equal(selfCompactState([{ type: 'tool/call', data: { name: 'pwsh' } }]), 'none'))
  t('★ 有登记、无消费标记 → request(压缩即将开始或已跳过,由宽限兜底)', () =>
    assert.equal(selfCompactState([req()]), 'request'))
  t('★ 登记后压缩开始 → inflight(压缩进行中,持续 hold)', () =>
    assert.equal(selfCompactState([req(), start()]), 'inflight'))
  t('★ 登记后压缩完成(end)→ none(已处理,会话真结束可放行)', () =>
    assert.equal(selfCompactState([req(), start(), end()]), 'none'))
  t('★ 登记后压缩器唤醒消息 → none(压缩成功唤醒路径)', () =>
    assert.equal(selfCompactState([req(), start(), wake()]), 'none'))
  t('历史登记已被消费、其后无新登记 → none(不误判)', () =>
    assert.equal(selfCompactState([req(), start(), end(), { type: 'assistant/message', data: {} }]), 'none'))
  t('压缩完成后又新登记(未消费)→ request(以最后一次登记为准)', () =>
    assert.equal(selfCompactState([req(), start(), end(), req()]), 'request'))
  t('其他工具调用/压缩器外的 user 消息不是消费标记', () =>
    assert.equal(selfCompactState([req(), { type: 'user/message', data: { role: 'user', source: { kind: 'other' } } }]), 'request'))
  t('compaction/prune 等旁支事件不算 start', () =>
    assert.equal(selfCompactState([req(), { type: 'compaction/prune', data: {} }]), 'request'))
}

console.log('lineageSids(顶层会话的谱系集合:后台作业按谱系枚举)')
{
  const hdr = map([
    H('main'),
    H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' }),
    H('sub2', { origin: 'subagent', delegationDepth: 2, parentSession: 'sub1' }),
    H('other'),
  ])
  const sessions = [
    { id: 'main', header: H('main') },
    { id: 'sub1', header: H('sub1', { origin: 'subagent', delegationDepth: 1, parentSession: 'main' }) },
    { id: 'sub2', header: H('sub2', { origin: 'subagent', delegationDepth: 2, parentSession: 'sub1' }) },
    { id: 'other', header: H('other') },
  ]
  t('主会话谱系 = 自身+全部后代(含深层)', () =>
    assert.deepEqual([...lineageSids('main', sessions, hdr)].sort(), ['main', 'sub1', 'sub2']))
  t('他会话不在谱系内', () =>
    assert.deepEqual([...lineageSids('other', sessions, hdr)], ['other']))
  t('空 sessions → 仅自身', () =>
    assert.deepEqual([...lineageSids('main', [], new Map())], ['main']))
  t('header 缺失的会话不崩、不误纳', () => {
    const s = [{ id: 'main', header: H('main') }, { id: 'x' }]
    assert.deepEqual([...lineageSids('main', s, hdr)].sort(), ['main'])
  })
}

console.log('gateConfigFromEnv(门控时序参数:5s 观察窗 / 10s 兜底 / 300s 压缩卡死护栏)')
t('默认 → 5000/10000/300000', () => {
  assert.deepEqual(gateConfigFromEnv({}), { watchMs: 5000, fallbackMs: 10000, inflightMs: 300000 })
})
t('env 覆盖 → 取给定值', () => {
  assert.deepEqual(gateConfigFromEnv({ DSH_NOTIFY_DONE_GRACE_MS: '8000', DSH_NOTIFY_DONE_FALLBACK_MS: '15000' }), { watchMs: 8000, fallbackMs: 15000, inflightMs: 300000 })
})
t('0 为合法值(0=不等,旧当拍语义)', () => {
  assert.deepEqual(gateConfigFromEnv({ DSH_NOTIFY_DONE_GRACE_MS: '0' }), { watchMs: 0, fallbackMs: 10000, inflightMs: 300000 })
})
t('非法(非数字/负数/空串)→ 回落默认', () => {
  assert.deepEqual(gateConfigFromEnv({ DSH_NOTIFY_DONE_GRACE_MS: 'abc', DSH_NOTIFY_DONE_FALLBACK_MS: '-5', DSH_NOTIFY_DONE_INFLIGHT_GRACE_MS: '' }), { watchMs: 5000, fallbackMs: 10000, inflightMs: 300000 })
})

console.log(`\n全部通过:${passed} 项`)
