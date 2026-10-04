// dsh-notify 运行集合判定逻辑单测(纯 node,无依赖)
// 场景覆盖:主代理/子代理/多级子代理/fork 会话 的完成边沿语义
import assert from 'node:assert/strict'
import { isSubagentHeader, topRootOf, computeRunningSet, readEvents } from '../lib/index.js'

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

console.log(`\n全部通过:${passed} 项`)
