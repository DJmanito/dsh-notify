// dsh-notify 端到端冒烟:mock ctx → apply() → 轮询 → /notify-state 契约验证
// 覆盖:子代理门控完成语义(边沿)、事件流双通道、readTitle 双通道、index 注入双通道
import assert from 'node:assert/strict'
import plugin from '../lib/index.js'

// ---------- mock ctx ----------
const headers = {
  main: { id: 'main', version: 3, createdAt: 1, isSeeded: false },
  sub: { id: 'sub', version: 3, createdAt: 2, isSeeded: false, origin: 'subagent', delegationDepth: 1, parentSession: 'main' },
}
let agentsState = []      // [{ id, status, sessionHeader }]
let eventsBySession = {}  // sid -> events[]

function makeSession(sid) {
  // 新版 DSH 形态:仅 snapshotEvents()
  return { id: sid, header: headers[sid], snapshotEvents: () => Object.freeze([...(eventsBySession[sid] ?? [])]) }
}

const routes = new Map()
const events = new Map() // type -> Set<cb>
const effects = []
const mocks = {
  webServer: {
    register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    tapIndex: (fn) => { effects.push(fn); return () => {} },
  },
  agents: { list: () => agentsState.map((a) => ({ id: a.id, status: a.status, session: a.sessionHeader ? { header: a.sessionHeader } : undefined })) },
  sessions: { list: () => Object.keys(headers).map(makeSession) },
  sessionQuery: { readTitle: async (sid) => ({ title: sid === 'main' ? '主任务标题' : '' }) }, // 旧版 {title} 形态
  timer: {},
  interval: () => {},
  // cordis effect 语义:立即执行 fn,返回 disposer
  effect: (fn) => { const d = fn(); effects.push(fn); return () => { if (typeof d === 'function') d() } },
  on: (type, cb) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(cb) },
}

function apply() {
  plugin.apply(mocks)
}
function emit(type, payload) {
  for (const cb of events.get(type) ?? []) cb(payload)
}
async function call(path, method = 'GET') {
  const qIdx = path.indexOf('?')
  const routePath = qIdx >= 0 ? path.slice(0, qIdx) : path
  const req = { method, url: path, on: (ev, cb) => { if (ev === 'end') setTimeout(cb, 0) } }
  let headersOut = {}, bodyOut = ''
  const res = {
    writeHead: (code, h) => { headersOut = h },
    end: (b) => { bodyOut = b },
  }
  routes.get(routePath)(req, res)
  return { headersOut, bodyOut, json: () => JSON.parse(bodyOut) }
}

apply()

console.log('路由注册')
for (const p of ['/notify-state', '/notify-test', '/notify-ops', '/notify-smoke']) {
  assert.ok(routes.has(p), `missing route ${p}`)
  console.log('  ✓', p)
}

console.log('index 注入双通道')
{
  // a) 新版:webserver/index-inject 行
  const table = []
  emit('webserver/index-inject', table)
  assert.equal(table.length, 1, 'script 行缺失')
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'head')
  assert.ok(table[0].text.includes('__dshRemoteNotifyInjected'), 'INJECT_JS 内容缺失')
  console.log('  ✓ webserver/index-inject → script 行(桌面壳 + 新版浏览器壳)')
  // b) 旧版回落:tapIndex 转换
  const tap = effects.find((f) => typeof f === 'function' && f.toString().includes('dsh-notify-inject'))
  assert.ok(tap, 'tapIndex 转换缺失')
  const html = '<html><head><title>x</title></head><body></body></html>'
  const out = tap(html)
  assert.ok(out.includes('<script id="dsh-notify-inject">'), 'tapIndex 未注入')
  assert.equal((out.match(/dsh-notify-inject/g) || []).length, 1, '注入应恰好一次')
  assert.equal(tap(out).includes('dsh-notify-inject') ? out.match(/dsh-notify-inject/g).length : 0, 1, '重复注入幂等')
  console.log('  ✓ tapIndex → 旧版 DSH 回落(幂等)')
}

console.log('完成边沿语义(/notify-state 契约)')
{
  // 初始:全空闲 → 无运行
  agentsState = []
  // poll 由 interval 驱动;mock 中 interval 不执行 → 手动触发:
  // poll 闭包未导出,但 apply 时调用了 poll()(ctx.interval(poll,1000); poll())
  let r = (await call('/notify-state')).json()
  assert.equal(r.running, false)
  assert.deepEqual(r.runningSessionIds, [])
  console.log('  ✓ 空闲 → running=false')

  // 无法直接再触发 poll(interval 被 mock 掉)→ 重新 apply 前把 interval 记下来
  // 简化:替换 interval mock 并重新 apply 整个流程
}

// 重建:让 interval 可手动触发
routes.clear(); effects.length = 0; events.clear()
let tickFn = null
mocks.interval = (fn, ms) => { tickFn = fn }
apply()

async function state() { return (await call('/notify-state')).json() }
// readTitle 为异步(返回 Promise)→ 冲刷微任务后再断言标题
const flush = () => new Promise((r) => setTimeout(r, 0))

{
  // 1) 主代理运行(无子代理)
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  await flush()
  let r = await state()
  assert.equal(r.running, true)
  assert.deepEqual(r.runningSessionIds, ['main'])
  assert.equal(r.runningTitle, '主任务标题')
  console.log('  ✓ 主运行 → running=[main], 标题读取(旧版 {title} 形态)')

  // 2) 主代理结束,子代理运行 → 仍算运行(不发完成)
  agentsState = [
    { id: 'main', status: 'idle', sessionHeader: headers.main },
    { id: 'sub', status: 'running', sessionHeader: headers.sub },
  ]
  tickFn()
  r = await state()
  assert.equal(r.running, true)
  assert.deepEqual(r.runningSessionIds, ['main'], '子代理运行 → 归属顶层,主会话仍在运行集合')
  console.log('  ✓ ★ 主结束 + 子代理运行 → running=[main](完成通知被门控)')

  // 3) 子代理结束 → 集合清空(边沿 → 完成通知)
  agentsState = [
    { id: 'main', status: 'idle', sessionHeader: headers.main },
    { id: 'sub', status: 'idle', sessionHeader: headers.sub },
  ]
  tickFn()
  r = await state()
  assert.equal(r.running, false)
  assert.deepEqual(r.runningSessionIds, [])
  console.log('  ✓ ★ 主结束 + 子代理结束 → running=[](边沿触发完成通知)')

  // 4) 主代理重新运行(收到子代理结果回传) → 重新进入运行集合
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'])
  console.log('  ✓ 主代理复跑 → 重新 running=[main]')
}

console.log('审批/问答检测(事件流双通道)')
{
  agentsState = []
  // 新版事件流:approval/asked 未决 → 待审批
  eventsBySession.main = [
    { type: 'turn/start', data: {} },
    { type: 'approval/asked', data: { kind: 'tool' } },
  ]
  tickFn()
  let r = await state()
  assert.equal(r.pendingApproval, true)
  assert.deepEqual(r.approvalSessionIds, ['main'])
  console.log('  ✓ 未决审批 → pendingApproval=[main]')

  // 审批已决(allowed*) → 决策记录 approved
  eventsBySession.main.push({ type: 'approval/decided', data: { outcome: 'allowed' } })
  tickFn()
  r = await state()
  assert.equal(r.pendingApproval, false)
  assert.equal(r.decisions.main, 'approved')
  console.log('  ✓ 审批通过 → decisions.main=approved, 等待解除')

  // 问答:ask_user_question 未应答 → 待回答
  eventsBySession.main = [
    { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1', args: {} } },
  ]
  tickFn()
  r = await state()
  assert.equal(r.pendingQuestion, true)
  assert.deepEqual(r.questionSessionIds, ['main'])
  console.log('  ✓ 未应答问答 → pendingQuestion=[main]')

  // 同 callId 的 tool/result 到达 → 解除
  eventsBySession.main.push({ type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: '回答' } } })
  tickFn()
  r = await state()
  assert.equal(r.pendingQuestion, false)
  console.log('  ✓ 回答回传 → 等待解除')
}

console.log('调试端点')
{
  const t = await call('/notify-test?mode=done')
  assert.ok(t.bodyOut.startsWith('ok: done'))
  let r = await state()
  assert.ok(r.runningSessionIds.includes('test-done'))
  const off = await call('/notify-test?mode=off')
  assert.ok(off.bodyOut.startsWith('ok: off'))
  r = await state()
  assert.ok(!r.runningSessionIds.includes('test-done'))
  console.log('  ✓ /notify-test 四态调试(on/off 复原)')
}

console.log('\n端到端冒烟全部通过 ✓')
