// dsh-notify 运行集合判定逻辑单测(纯 node,无依赖)
// 场景覆盖:主代理/子代理/多级子代理/fork 会话 的完成边沿语义
import assert from 'node:assert/strict'
import { isSubagentHeader, topRootOf, computeRunningSet, readEvents, buildToastXml, escapeXml, classifyPageUa, buildToastScripts } from '../lib/index.js'

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
  t('自定义 aumid 生效', () => {
    const { gcRaw } = buildToastScripts('T', 'B', 'X.Custom')
    assert.ok(gcRaw.includes("CreateToastNotifier('X.Custom')"))
  })
}

console.log(`\n全部通过:${passed} 项`)
