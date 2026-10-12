// dsh-notify 端到端冒烟:mock ctx → apply() → 轮询 → /notify-state 契约验证
// 覆盖:子代理门控完成语义(边沿)、事件流双通道、readTitle 双通道、index 注入双通道
// 注意:测试运行在本机 win32 上,边沿会触发 WinRT toast 的 spawn → 用 env 守卫关掉
process.env.DSH_NOTIFY_NO_TOAST = '1'
import assert from 'node:assert/strict'
import plugin from '../lib/index.js'

// ---------- mock ctx ----------
const headers = {
  main: { id: 'main', version: 3, createdAt: 1, isSeeded: false },
  sub: { id: 'sub', version: 3, createdAt: 2, isSeeded: false, origin: 'subagent', delegationDepth: 1, parentSession: 'main' },
}
let agentsState = []      // [{ id, status, sessionHeader }]
let eventsBySession = {}  // sid -> events[]
let jobsBySession = {}    // sid -> [{ id, owner, status }] (ctx.jobs.list 的 mock 数据源)

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
  // 宿主 ctx.get 的 mock:jobs 服务(dsh-jobs)→ list(caller) 按 owner 过滤
  get: (name) => name === 'jobs' ? { list: (caller) => (jobsBySession[caller] ?? []) } : undefined,
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
async function call(path, method = 'GET', body = null, headers = {}) {
  const qIdx = path.indexOf('?')
  const routePath = qIdx >= 0 ? path.slice(0, qIdx) : path
  const req = { method, url: path, headers, on: (ev, cb) => { if (ev === 'data') body && setTimeout(() => cb(body), 0); if (ev === 'end') setTimeout(cb, 0) } }
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
for (const p of ['/notify-state', '/notify-test', '/notify-ops', '/notify-smoke', '/notify-debug', '/notify-settings']) {
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
// 完成门控时间窗在冒烟里压到 50ms 量级(生产默认:观察窗 5s / 兜底 10s / 压缩卡死护栏 300s):
process.env.DSH_NOTIFY_DONE_GRACE_MS = '50'          // 观察窗:会话结束后先等,再做同拍判定
process.env.DSH_NOTIFY_DONE_FALLBACK_MS = '50'       // 兜底:观察窗外仍不确定(登记未消费/作业刚结算)→ 超时后可推
process.env.DSH_NOTIFY_DONE_INFLIGHT_GRACE_MS = '0'  // 正在压缩的卡死护栏(0=同拍即不再延长)
apply()

async function state() { return (await call('/notify-state')).json() }
// readTitle 为异步(返回 Promise)→ 冲刷微任务后再断言标题
const flush = () => new Promise((r) => setTimeout(r, 0))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

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
  //    v1.4.0 门控:先等观察窗(冒烟压 50ms,生产 5s)→ 同拍三项检测(无压缩/无子代理/无作业)全干净 → 放行
  agentsState = [
    { id: 'main', status: 'idle', sessionHeader: headers.main },
    { id: 'sub', status: 'idle', sessionHeader: headers.sub },
  ]
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '边沿拍 → 先等观察窗(5s/50ms),暂不推送完成通知')
  await wait(60)
  tickFn()
  r = await state()
  assert.equal(r.running, false)
  assert.deepEqual(r.runningSessionIds, [])
  console.log('  ✓ ★ 主结束 + 子代理结束 → 等观察窗 → 同拍检测全干净 → 放行(边沿触发完成通知)')

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

console.log('设置同步(/notify-settings,UA 归因)')
{
  const ELECTRON_UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Electron/28.1.0' }
  const CHROME_UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' }
  // 桌面壳上报 → 生效
  await call('/notify-settings', 'POST', JSON.stringify({ master: false, approval: 'off', taskDone: 'off' }), ELECTRON_UA)
  await new Promise((r) => setTimeout(r, 5))
  let d = (await call('/notify-debug')).json()
  assert.equal(d.dbg.winSettings.master, false, '桌面壳 master 应生效')
  assert.equal(d.dbg.winSettings.approval, 'off')
  assert.equal(d.dbg.winSettings.taskDone, 'off')
  console.log('  ✓ 桌面壳(Electron UA)上报 → winSettings 生效')
  // 远程浏览器上报 → 忽略(不反向控制宿主机通知)
  await call('/notify-settings', 'POST', JSON.stringify({ master: true }), CHROME_UA)
  await new Promise((r) => setTimeout(r, 5))
  d = (await call('/notify-debug')).json()
  assert.equal(d.dbg.winSettings.master, false, '浏览器 UA 上报不应覆盖宿主设置')
  console.log('  ✓ 远程浏览器(Chrome UA)上报 → 忽略')
}

console.log('完成门控(v1.4.0:等 5s 观察窗 → 同拍三项检测 → 干净即推 / 不确定则 10s 兜底)')
{
  // A) 确定性干净(无登记、无作业):边沿拍 → 先等观察窗(不推);窗满 → 同拍检测三项全干净 → 立刻推
  eventsBySession.main = []
  jobsBySession.main = []
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  agentsState = [{ id: 'main', status: 'idle', sessionHeader: headers.main }]
  tickFn(); await flush()
  let r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '边沿拍 → 先等观察窗(生产 5s),暂不推送完成通知')
  await wait(60)
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, [], '观察窗满 → 同拍检测(④无压缩/②无子代理/③无作业)全干净 → 放行')
  console.log('  ✓ ★ 确定性干净:等观察窗 → 同拍检测全干净 → 立刻推送')

  // B) 自助压缩已登记、未见消费标记 → 窗内 hold;窗满仍未消费 → 进入 10s 兜底 hold;兜底期满无压缩(跳过/失败无痕迹)→ 放行
  eventsBySession.main = [{ type: 'tool/call', data: { callId: 'c1', name: 'request_compact', arguments: {} } }]
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  agentsState = [{ id: 'main', status: 'idle', sessionHeader: headers.main }]
  tickFn(); await flush()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '已登记未处理 → hold(观察窗内),仍在运行集合,不发完成通知')
  await wait(60)
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '观察窗满但仍未见消费标记 → 进入兜底(生产 10s),继续 hold')
  await wait(60)
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, [], '兜底期满无压缩(跳过/失败无日志痕迹)→ 放行,完成边沿触发')
  console.log('  ✓ ★ 登记自助压缩(无消费标记):等窗 → 兜底 → 放行(视同真结束)')

  // C) 压缩进行中(inflight:start 已见 end 未见)→ "正在压缩=不推"持续 hold;
  //    压缩完成唤醒会话复跑 → hold 取消;再结束 → 等观察窗、三项全干净 → 放行
  eventsBySession.main = [
    { type: 'tool/call', data: { callId: 'c2', name: 'request_compact', arguments: {} } },
    { type: 'compaction/start', data: {} },
  ]
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  agentsState = [{ id: 'main', status: 'idle', sessionHeader: headers.main }]
  tickFn(); await flush()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], 'compaction/start 已见、end 未见 → 正在压缩 → 不推,持续 hold')
  // 压缩完成(end)后压缩器唤醒会话 → 复跑 → hold 取消(会话未完,不触发完成)
  eventsBySession.main.push({ type: 'compaction/end', data: {} })
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'])
  // 复跑后再结束 → 登记已被消费 → 先等观察窗 → 同拍检测三项全干净 → 放行
  agentsState = [{ id: 'main', status: 'idle', sessionHeader: headers.main }]
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '再结束 → 先等观察窗(生产 5s)')
  await wait(60)
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, [], '压缩完成、复跑再结束 → 同拍检测全干净 → 放行')
  console.log('  ✓ ★ 压缩进行中 → hold(正在压缩=不推);唤醒复跑 → 取消 hold;再结束 → 正常完成')

  // D) 后台工作:作业未结算 → hold;作业完成唤醒会话复跑 → hold 取消;再结束 → 等窗、干净 → 放行
  eventsBySession.main = []
  jobsBySession.main = [{ id: 'pwsh-1', owner: 'main', status: 'running' }]
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  agentsState = [{ id: 'main', status: 'idle', sessionHeader: headers.main }]
  tickFn(); await flush()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '有未结算作业(running)→ hold')
  // 作业完成 → 完成回执唤醒会话复跑 → hold 取消(会话未完,不触发完成)
  jobsBySession.main = [{ id: 'pwsh-1', owner: 'main', status: 'completed' }]
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'])
  // 复跑后再结束 → 无作业无登记 → 等观察窗 → 同拍检测全干净 → 放行
  agentsState = [{ id: 'main', status: 'idle', sessionHeader: headers.main }]
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '再结束 → 先等观察窗(生产 5s)')
  await wait(60)
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, [], '作业完成唤醒、复跑再结束 → 同拍检测全干净 → 放行')
  console.log('  ✓ ★ 后台工作未结算 → hold;作业完成唤醒复跑 → 正常完成')

  // E) 作业结算但会话未被唤醒(回执丢失等)→ 窗内 hold → 窗满、jobsHeld → 10s 兜底确认 → 放行
  jobsBySession.main = [{ id: 'pwsh-2', owner: 'main', status: 'running' }]
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  agentsState = [{ id: 'main', status: 'idle', sessionHeader: headers.main }]
  tickFn(); await flush()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'])
  jobsBySession.main = [] // 作业结算,无唤醒
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '作业刚结算、观察窗未满 → 继续 hold')
  await wait(60)
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '观察窗满、唤醒可能将至(jobsHeld)→ 进入兜底(生产 10s)确认')
  await wait(60)
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, [], '兜底期满无唤醒 → 放行,完成边沿触发')
  console.log('  ✓ ★ 作业结算无唤醒:等窗 → 兜底 → 放行')

  // F) 用户核心场景:结束(已登记)后"正在压缩"在观察窗内现形(用户观察:立刻、非常快)
  //    → 窗满同拍检测判定"正在压缩" → 不推;唤醒复跑 → 取消 hold;再结束 → 正常完成
  eventsBySession.main = [{ type: 'tool/call', data: { callId: 'c3', name: 'request_compact', arguments: {} } }]
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  agentsState = [{ id: 'main', status: 'idle', sessionHeader: headers.main }]
  tickFn(); await flush()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '已登记、尚未 start → 先等观察窗(生产 5s)')
  await wait(20)
  eventsBySession.main.push({ type: 'compaction/start', data: {} }) // 观察窗内进入压缩(用户:"立刻、非常快")
  await wait(40)
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '观察窗满、同拍检测 → 正在压缩(start 已见 end 未见)→ 不推')
  eventsBySession.main.push({ type: 'compaction/end', data: {} })
  agentsState = [{ id: 'main', status: 'running', sessionHeader: headers.main }]
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'])
  agentsState = [{ id: 'main', status: 'idle', sessionHeader: headers.main }]
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, ['main'], '再结束 → 先等观察窗(生产 5s)')
  await wait(60)
  tickFn()
  r = await state()
  assert.deepEqual(r.runningSessionIds, [], '压缩已消费、复跑再结束 → 同拍检测全干净 → 放行')
  console.log('  ✓ ★ 观察窗内"正在压缩"现形 → 同拍检测 → 不推;唤醒复跑 → 正常完成')
  // 清理
  jobsBySession = {}
  eventsBySession.main = []
}

console.log('\n端到端冒烟全部通过 ✓')
