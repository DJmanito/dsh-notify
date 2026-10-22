// @ts-check
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// dsh-notify: DSH 浏览器通知推送插件(npm 包 @djmanito/dsh-notify)
//
// 功能:
//   检测:秒级轮询 agents/sessions 状态
//   GET /notify-state  → 10 字段状态端点(手机 App 轮询源;含 decisions 审批判定)
//   GET /notify-test?mode=approval|done|question|off  → 四态调试标志(仅改内存)
//   GET/POST /notify-smoke  → 注入脚本冒烟探测报告
//   GET/POST /notify-ops    → 通知操作日志(诊断撤回等问题)
//   页面注入 → DSH 桌面 GUI 标签闪烁 + 系统通知(Notification API;
//          三态语义:一直=每次新tag弹+响 / 静默=同tag更新仅首次弹 / 关=不发;
//          图标 ⏳/✅通过/❌不通过;撤回=清 sid 名下全部 tag;UA 含 DshNotify 的手机 WebView 不挂载)
//   设置 UI = 本包 client 模块(DSH 设置页「通知设置」分区,与注入脚本共享浏览器 localStorage)
//
// 检测逻辑:
//   运行中 = 主会话的 agent status === 'running',或其名下(沿 parentSession 谱系归属到
//            顶层会话)存在运行中的子代理;子代理自身完成不直接触发通知。
//   会话完成 = 主代理与它的全部子代理都结束(running 差集边沿)。
//             主代理结束但子代理仍在运行 → 不发完成通知,直到最后一个子代理也结束。
//             完成门控四条件(v1.4.0): ①主代理会话结束 ②子代理均结束(①②由 running 集合语义承载:
//             主代理 running 或名下子代理 running → 顶层会话在集合内) ③无后台工作 ④未处于自助压缩中。
//             时序(用户观察,见 doneGate 注释):会话结束(集合边沿)后先等 5s 观察窗(DSH_NOTIFY_DONE_GRACE_MS),
//             再做一次同拍判定:④正在压缩?(compaction/start 已见而 end 未见) ②子代理是否全结束 ③后台作业是否全结算;
//             三项全干净 ⇒ 立刻推送;仍不确定(见登记痕迹但压缩未启动 / 作业刚结算)⇒ 兜底 10s
//             (DSH_NOTIFY_DONE_FALLBACK_MS)后视同可推。
//             会话离集合后先被暂留在暴露的 running 集合中(hold),压缩/作业唤醒重新 running → hold 取消,
//             完成边沿(服务端 WinRT 与 /notify-state 渲染端同口径)才触发。详见 doneGate / selfCompactState。
//   待审批 = 会话事件流末尾为 approval/asked 且其后无 approval/decided;
//   待回答 = 会话存在 tool/call(name=ask_user_question, 带 callId) 且其后无
//            同 callId 的 tool/result(关联键 = tool/result.data.message.source.callId);
//   审批判定 = approval/decided.data.outcome(allowed* = 通过,其余 = 不通过)。
//
// 环境兼容(桌面端 + 浏览器端 + 旧版 DSH):
//   页面注入双通道——
//     新版 DSH(桌面壳 + 浏览器壳):订阅 webserver/index-inject 事件,推结构化 script 行。
//       桌面壳静态服务 index.html 并经启动 payload 携带注入行(页面端解释执行);
//       浏览器壳由 renderIndex 把行渲染进下发的 index.html。
//     旧版 DSH(仅浏览器壳):上述事件不存在 → 订阅静默无效,回落 tapIndex 原始转换注入。
//       新版浏览器壳两者都会注入,注入脚本内置幂等守卫(window.__dshRemoteNotifyInjected),
//       第二次执行直接返回,无副作用。
//   事件流读取双通道:新版 Session 无 .events 属性 → 用 session.snapshotEvents();
//     旧版回落 session.events(纯数组)。
//   readTitle 双通道:新版返回字符串,旧版返回 { title }。
//
// 约束:不写文件、不碰网络(仅注册上述只读/调试路由)。
// 安装:npm 包形态,进 DSH profile 的 node_modules + dsh.profile.bundles(见包 README)。
// 回滚:从 bundles 数组移除包名 + npm rm + 重启 DSH。

// ---------- 注入脚本(冒烟 + 闪烁 + 系统通知) ----------
// 注意:内容禁止出现 ` 与 ${ (模板字面量载体);禁止出现 </script> 字面量。
const INJECT_JS = `
(function () {
  if (window.__dshRemoteNotifyInjected) return
  window.__dshRemoteNotifyInjected = true

  // 手机 DSH Remote · Notify App 的 WebView(UA 含 DshNotify)不挂载:手机端有原生通知
  if (navigator.userAgent.indexOf('DshNotify') >= 0) return

  // 设置与 DSH 设置页「通知设置」(client 模块)共享浏览器 localStorage;
  // 每个 tick 重读,设置页改动 ≤1.5s 生效
  var LS_KEY = 'dshRemoteNotifySettings'
  function loadLS() {
    var s = { master: true, approval: 'always', approvalDone: 'off', taskDone: 'always', approvalCleanup: true, sessionBlacklist: [], version: 1 }
    try {
      var raw = localStorage.getItem(LS_KEY)
      if (raw) {
        var p = JSON.parse(raw)
        if (typeof p.master === 'boolean') s.master = p.master
        if (['always', 'silent', 'off'].indexOf(p.approval) >= 0) s.approval = p.approval
        if (['always', 'off'].indexOf(p.approvalDone) >= 0) s.approvalDone = p.approvalDone
        if (['always', 'silent', 'off'].indexOf(p.taskDone) >= 0) s.taskDone = p.taskDone
        if (typeof p.approvalCleanup === 'boolean') s.approvalCleanup = p.approvalCleanup
        if (Array.isArray(p.sessionBlacklist)) s.sessionBlacklist = p.sessionBlacklist.filter(function (x) { return typeof x === 'string' }).map(function (x) { return x.trim() }).filter(function (x) { return x !== '' })
      }
    } catch (e) {}
    return s
  }
  var settings = loadLS()
  var firstTick = true
  var lastApproval = {}, lastQuestion = {}, lastRunning = {}
  var origTitle = null
  var flashTimer = null
  var flashing = false

  // 会话 ID 黑名单:去空白后全等匹配;命中的会话完成时不发"会话已完成"通知(审批/回答不受影响)
  function sidBlacklisted(sid) {
    var bl = (settings && settings.sessionBlacklist) || []
    var s = String(sid == null ? '' : sid).trim()
    for (var i = 0; i < bl.length; i++) {
      if (typeof bl[i] === 'string' && bl[i].trim() === s) return true
    }
    return false
  }

  function nOk() { return typeof window.Notification !== 'undefined' }
  function nGranted() { return nOk() && Notification.permission === 'granted' }
  function ensurePerm() { if (nOk() && Notification.permission === 'default') { try { Notification.requestPermission() } catch (e) {} } }

  function flash(text, keep) {
    if (origTitle === null) origTitle = document.title
    flashing = true
    document.title = text
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null }
    if (!keep) flashTimer = setTimeout(function () { restoreTitle() }, 2500)
  }
  function restoreTitle() {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null }
    if (flashing) { if (origTitle !== null) document.title = origTitle; origTitle = null; flashing = false }
  }

  // 三态语义(用户定义):一直=每次新 tag(弹+响);静默=同 tag 更新(仅首次弹+响);关=不发
  var notifiedInstances = {}
  var tagsBySid = {}
  function reportOp(kind, extra) {
    var op = { kind: kind, ts: Date.now() }
    for (var k in (extra || {})) op[k] = extra[k]
    fetch('/notify-ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) }).catch(function () {})
  }
  function pushTag(sid, kind, tag) {
    if (!tagsBySid[sid]) tagsBySid[sid] = {}
    var arr = tagsBySid[sid][kind] || (tagsBySid[sid][kind] = [])
    arr.push(tag)
    if (arr.length > 5) arr.shift()
  }
  function notify(title, body, tag) {
    if (!nGranted()) { reportOp('post-skip', { reason: 'not-granted', tag: tag }); return null }
    try {
      var n = new Notification(title, { body: body, tag: tag })
      n.onclick = function () { window.focus(); try { n.close() } catch (e) {} }
      notifiedInstances[tag] = n
      reportOp('post', { title: title, tag: tag })
      return n
    } catch (e) {
      reportOp('post-fail', { err: String(e).slice(0, 80), tag: tag })
      return null
    }
  }
  function cancelTag(tag) { if (nOk()) { try { Notification.cancel(tag) } catch (e) {} } }
  function withdrawSid(sid, kind) {
    var arr = tagsBySid[sid] && tagsBySid[sid][kind]
    if (!arr || !arr.length) { reportOp('cancel-miss', { sid: sid, kind: kind }); return }
    arr.forEach(function (t) {
      var inst = notifiedInstances[t]
      if (inst) { try { inst.close() } catch (e) {} delete notifiedInstances[t] }
      cancelTag(t)
      reportOp('cancel', { sid: sid, kind: kind, tag: t })
    })
    tagsBySid[sid][kind] = []
  }

  function onApprovalNew(sid, title) {
    if (!settings || !settings.master || settings.approval === 'off') return
    var t = settings.approval === 'silent' ? 'appr-' + sid : 'appr-' + sid + '-' + Date.now()
    notify('⏳ DSH 会话等待审批', title || '有会话等待审批', t)
    pushTag(sid, 'appr', t)
  }
  function onQuestionNew(sid, title) {
    if (!settings || !settings.master || settings.approval === 'off') return
    var t = settings.approval === 'silent' ? 'q-' + sid : 'q-' + sid + '-' + Date.now()
    notify('⏳ DSH 会话等待回答', title || '有会话等待回答', t)
    pushTag(sid, 'q', t)
  }
  function onApprovalResolved(sid, decision) {
    if (!settings) return
    if (settings.approvalCleanup) withdrawSid(sid, 'appr')
    if (settings.approvalDone === 'always') {
      var denied = decision === 'denied'
      notify(denied ? '❌ 审批未通过' : '✅ 审批已通过', denied ? '审批被拒绝' : '审批已允许', 'doneappr-' + sid + '-' + Date.now())
    }
  }
  function onQuestionResolved(sid) {
    if (!settings) return
    if (settings.approvalCleanup) withdrawSid(sid, 'q')
    if (settings.approvalDone === 'always') notify('✅ 已收到回答', '回答已回传', 'doneq-' + sid + '-' + Date.now())
  }
  function onSessionDone(sid, title) {
    if (!settings || !settings.master || settings.taskDone === 'off') return
    if (sidBlacklisted(sid)) { reportOp('done-skip', { reason: 'blacklisted', sid: sid }); return }
    var t = settings.taskDone === 'silent' ? 'done-' + sid : 'done-' + sid + '-' + Date.now()
    notify('✅ DSH 会话已完成', title || '会话已完成', t)
  }

  // 设置同步:把本页设置上报后端(变更时触发),让 WinRT 直发通道受同一套设置管理。
  // 后端按 UA 归因:桌面壳的页面上报 = 宿主机设置;远程浏览器/手机的上报被忽略。
  // body 字节预算:服务端 /notify-settings 的 body 上限 = 8192 字节(见 5b 节常量 SETTINGS_BODY_MAX_BYTES)。
  // 发送前截断预算算式(按"完整 settings JSON ≤ 8192 字节"倒推):
  //   baseBytes  = JSON.stringify({...settings, sessionBlacklist: []}) 的 UTF-8 字节数
  //   entryBytes = 每条 '"id",' 的 UTF-8 字节数(含引号与尾随逗号;末条多计 1 字节,安全方向)
  //   取满足 baseBytes + Σ entryBytes ≤ 8192 的最长前缀,超预算条目从尾部丢弃
  //   → 黑名单过长会部分生效(仅头部条目上报,尾部条目本次不生效;其余设置字段不受影响)
  var NOTIFY_SETTINGS_BODY_MAX = 8192
  var _enc = (typeof TextEncoder === 'function') ? new TextEncoder() : null
  function utf8Bytes(s) { return _enc ? _enc.encode(s).length : s.length }
  function fitBlacklistByBytes(list) {
    var baseBytes = utf8Bytes(JSON.stringify(Object.assign({}, settings, { sessionBlacklist: [] })))
    var out = []
    var used = baseBytes
    for (var i = 0; i < list.length; i++) {
      var entryBytes = utf8Bytes(JSON.stringify(list[i]) + ',')
      if (used + entryBytes > NOTIFY_SETTINGS_BODY_MAX) break
      used += entryBytes
      out.push(list[i])
    }
    return out
  }
  var lastSyncedSig = ''
  function syncSettings() {
    if (!settings) return
    var fit = fitBlacklistByBytes(settings.sessionBlacklist || [])
    var body = Object.assign({}, settings, { sessionBlacklist: fit })
    // sig 用截断后列表:仅当实际发出的内容变化才重报(列表再增长但截断前缀不变 → 不重发)
    var sig = [settings.master, settings.approval, settings.approvalDone, settings.taskDone, settings.approvalCleanup, JSON.stringify(fit)].join('|')
    if (sig === lastSyncedSig) return
    lastSyncedSig = sig
    fetch('/notify-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('notify-settings HTTP ' + r.status) })
      .catch(function () { lastSyncedSig = '' }) // 上报失败(request destroyed / 非 2xx / 抛错)清签名 → 下一轮 tick 重新上报,避免服务端静默滞留旧值
  }

  function tick() {
    // 设置页改动 ≤1.5s 生效(localStorage 共享)
    var cur = loadLS()
    if (JSON.stringify(cur) !== JSON.stringify(settings)) settings = cur
    syncSettings()
    ensurePerm()
    fetch('/notify-state').then(function (r) { return r.ok ? r.json() : null }).then(function (s) {
      if (!s) return
      var a = {}, q = {}, rn = {}
      ;(s.approvalSessionIds || []).forEach(function (x) { a[x] = 1 })
      ;(s.questionSessionIds || []).forEach(function (x) { q[x] = 1 })
      ;(s.runningSessionIds || []).forEach(function (x) { rn[x] = 1 })
      if (!firstTick) {
        var dec = s.decisions || {}
        Object.keys(lastApproval).forEach(function (sid) { if (!a[sid]) onApprovalResolved(sid, dec[sid]) })
        Object.keys(lastQuestion).forEach(function (sid) { if (!q[sid]) onQuestionResolved(sid) })
        Object.keys(lastRunning).forEach(function (sid) {
          if (!rn[sid]) {
            onSessionDone(sid, s.runningTitle)
            if (!flashing) flash('✅ 任务完成', false)
          }
        })
      }
      Object.keys(a).forEach(function (sid) { if (!lastApproval[sid]) onApprovalNew(sid, s.approvalTitle) })
      Object.keys(q).forEach(function (sid) { if (!lastQuestion[sid]) onQuestionNew(sid, s.questionTitle) })
      firstTick = false
      lastApproval = a; lastQuestion = q; lastRunning = rn
      var na = Object.keys(a).length, nq = Object.keys(q).length
      if (na || nq) {
        var t = na ? '⏳ 等待审批' : ''
        if (nq) t = t ? t + ' / 等待回答' : '⏳ 等待回答'
        var ttl = (na ? s.approvalTitle : s.questionTitle) || ''
        flash(t + (ttl ? ' · ' + ttl.slice(0, 24) : ''), true)
      } else if (flashing) { restoreTitle() }
    }).catch(function () {})
  }

  // 冒烟探测:上报 Notification 可用性
  setTimeout(function () {
    var rep = {
      notif: typeof window.Notification,
      perm: nOk() ? Notification.permission : 'n/a',
      secure: window.isSecureContext,
      href: location.href.slice(0, 80),
      ts: Date.now()
    }
    fetch('/notify-smoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rep) }).catch(function () {})
  }, 1500)

  setTimeout(tick, 2000)
  setInterval(tick, 1500)
})()
`

// ---------- 运行集合判定(纯函数,可单测) ----------
// 子代理判定只用权威谱系标记(origin/delegationDepth)。
// 对话 fork 也带 parentSession 但无这两个标记——它是用户可直接操作的
// 顶层会话,按主会话计(其完成应通知)
export const isSubagentHeader = (h) =>
  !!(h && (h.origin === 'subagent' || (typeof h.delegationDepth === 'number' && h.delegationDepth > 0)))

// 子代理会话 → 顶层(主)会话归属:沿 parentSession 向上爬(仅走活跃会话),
// 父会话离线时凭 delegationDepth===1 语义断定其父即顶层;
// 无法确定谱系时返回 null(保守:不归属,避免把运行态记到子会话 id 上)
export function topRootOf(sid, headerById) {
  let h = headerById.get(sid)
  let guard = 0
  while (h && guard++ < 64) {
    if (!h.parentSession) return h.id
    if (typeof h.delegationDepth === 'number' && h.delegationDepth === 1) return h.parentSession
    h = headerById.get(h.parentSession)
  }
  return null
}

// 运行中集合(完成通知的边沿源):
//   主会话 agent 运行中 → 记主会话 id;
//   子代理运行中 → 归属到其顶层主会话 id。
// 主代理已结束但子代理未完 → 顶层 id 仍在集合中 → 不发"会话完成";
// 主代理与全部子代理都结束 → 顶层 id 离集合 → running 差集边沿 → 才发通知。
// agents: [{ id, status, header }](header 取不到时回落到 headerById)
export function computeRunningSet(agents, headerById) {
  const set = new Set()
  for (const agent of agents) {
    if (!agent || agent.status !== 'running') continue
    const sid = agent.id
    const h = agent.header || headerById.get(sid) || {}
    if (isSubagentHeader(h)) {
      const root = topRootOf(sid, headerById)
      if (root) set.add(root)
    } else {
      set.add(sid)
    }
  }
  return [...set]
}

// ---------- 完成门控:自助压缩登记状态(纯函数,可单测) ----------
// "登记自助压缩" = 主代理本轮调用过 preset 空闲窗口压缩器(compactor.mjs)登记的 request_compact 工具。
// 登记状态本体(armed)只存在于该插件自身的内存闭包(WeakMap),本侧读不到;但它的生命周期在会话
// 事件流里留有可验证痕迹(全部经 DSH 0.2.0-rc2 实机会话数据核对):
//   登记标记 = tool/call(data.name='request_compact') —— 一切工具调用都会入流(dsh-agent-loop);
//   消费标记 = compaction/start | compaction/end(dsh-compaction-basic 写日志),或
//              user/message(data.source.kind='plugin:hybrid-idle-compactor')——压缩器的唤醒/回执消息。
// 判定(自最后一次登记向后看):
//   'none'     无登记,或登记后已出现消费标记 → 无待处理压缩;
//   'request'  有登记、尚无任何消费标记 → 压缩即将开始或已被跳过/失败(后两者不入日志、
//              无法区分 → 由调用方宽限期放行);
//   'inflight' 已出现 compaction/start 但 end/唤醒未见 → 压缩进行中(压缩完成后压缩器会唤醒会话)。
export function selfCompactState(evs) {
  if (!Array.isArray(evs) || !evs.length) return 'none'
  let lastReq = -1
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]
    if (e && e.type === 'tool/call' && e.data && e.data.name === 'request_compact') { lastReq = i; break }
  }
  if (lastReq < 0) return 'none'
  let started = false
  for (let j = lastReq + 1; j < evs.length; j++) {
    const e = evs[j]
    if (!e) continue
    if (e.type === 'compaction/start') { started = true; continue }
    if (e.type === 'compaction/end') return 'none'
    if (e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'plugin:hybrid-idle-compactor') return 'none'
  }
  return started ? 'inflight' : 'request'
}

// 谱系会话集合:顶层会话自身 + 沿 parentSession 归属到它的其余会话(含已结束未归档的子代理会话)。
// 背景作业按"启动它的会话"归属(job.owner),子代理起的作业挂在子会话名下,
// 故"某顶层会话有无后台工作"需按谱系枚举后再查 ctx.jobs。
export function lineageSids(rootSid, sessions, headerById) {
  const out = new Set([rootSid])
  for (const s of sessions) {
    if (!s || !s.id || s.id === rootSid) continue
    let root = null
    try { root = topRootOf(s.id, headerById) } catch { root = null }
    if (root === rootSid) out.add(s.id)
  }
  return out
}

// 门控时序参数(纯函数,可单测):会话结束后的三个时间窗,均可被环境变量覆盖(0 为合法值)。
// 默认值依据(用户观察原话):"会话登记压缩-会话结束后我之前看过,都是立刻会进入压缩状态的,非常快"
//   → 登记→进入压缩极快,5s 观察窗足以让"正在压缩"(inflight)现形;
//   → 兜底取 10s(v1.3.0 的 30s 弃用):观察窗外仍不确定的窗口,再等 10s 无活动即视同可推;
//   → 压缩卡死护栏 300s:compaction/start 后一直无 end 的异常边界,超时强制放行。
export function gateConfigFromEnv(env = process.env) {
  const pick = (v, dflt) => {
    if (v === undefined || v === null || String(v).trim() === '') return dflt // 空串=未设置(避免 Number('')=0)
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : dflt
  }
  return {
    watchMs: pick(env.DSH_NOTIFY_DONE_GRACE_MS, 5000),        // 观察窗:结束后先等,再做同拍判定
    fallbackMs: pick(env.DSH_NOTIFY_DONE_FALLBACK_MS, 10000),  // 兜底:窗外仍不确定 → 超时后可推
    inflightMs: pick(env.DSH_NOTIFY_DONE_INFLIGHT_GRACE_MS, 300000), // 正在压缩的卡死护栏
  }
}

// 读取会话事件流:新版 DSH 的 Session 无 .events 属性(用 snapshotEvents()),
// 旧版为纯数组 session.events → 双通道兼容
export const readEvents = (session) => {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      const evs = session.snapshotEvents()
      if (Array.isArray(evs)) return evs
    } catch (e) { /* 继续回落 */ }
  }
  if (Array.isArray(session.events)) return session.events
  return []
}

// ---------- 访问端分类(纯函数,可单测) ----------
// /notify-settings 上报归因:WinRT toast 是宿主机本地通知,只接受桌面壳(Electron)页面上报的设置;
// 远程浏览器/手机 App 的设置不应反向控制宿主机通知。
export const classifyPageUa = (ua) => {
  const s = String(ua || '')
  if (!s) return 'unknown'
  if (s.indexOf('DshNotify') >= 0) return 'phone'
  if (/Electron/i.test(s)) return 'desktop-shell'
  if (/Chrome|Firefox|Safari|Edg/i.test(s)) return 'browser' // Edge UA 实际是 Edg/x.x
  return 'other'
}

// ---------- Windows toast XML(纯函数,可单测) ----------
// WinRT ToastText02: 主标题 + 正文;默认提示音;AUMID 由调用方传入 CreateToastNotifier
export const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export const buildToastXml = (title, body) => {
  const t = escapeXml(String(title ?? '')).slice(0, 100)
  const b = escapeXml(String(body ?? '')).slice(0, 200)
  return '<toast><audio silent="false" /><visual><binding template="ToastText02">' +
    '<text id="1">' + t + '</text><text id="2">' + b + '</text>' +
    '</binding></visual></toast>'
}

// ---------- WinRT toast PowerShell 脚本生成(纯函数,可单测) ----------
// 父进程脚本:直接发 toast;若 0x80073D54(宿主应用设置的包标识 AUMID 被子进程继承 → WinRT 拒绝)
//   → 经 WMI Win32_Process.Create 创建孙进程(父 = WMI 服务,token 无继承 AUMID)重试。
// 孙进程脚本:仅直接发。命令行全 base64 编码(-EncodedCommand),规避嵌套引号。
// aumids:候选列表按序尝试(通知中心显示的发送者名 = AUMID 本身;非打包应用无法单独设显示名)。
//   首选 'DSH 通知'(用户偏好);若 WinRT 拒绝(如非法字符)自动回落 'DshNotify'。
export const TOAST_AUMIDS = ['DSH 通知', 'DshNotify']
export const buildToastScripts = (title, body, aumids = TOAST_AUMIDS) => {
  const list = Array.isArray(aumids) && aumids.length ? aumids : [aumids]
  const xml = buildToastXml(title, body)
  const b64 = (s) => Buffer.from(s, 'utf16le').toString('base64')
  const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const aumidList = list.map((a) => psq(String(a))).join(', ')
  const loadLines = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$x.LoadXml(' + psq(xml) + ')',
  ]
  // 候选循环:成功即停;0x80073D54(身份污染)记 $identity;其他错误(如 AUMID 非法)换下一个
  const candidateLoop = [
    '$ok = $false',
    '$identity = $false',
    '$lastErr = $null',
    'foreach ($a in @(' + aumidList + ')) {',
    '  try {',
    '    $n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($a)',
    '    $n.Show((New-Object Windows.UI.Notifications.ToastNotification $x))',
    '    $ok = $true; break',
    '  } catch {',
    '    $lastErr = $_.Exception',
    '    $i = $lastErr; while ($i -and $i.InnerException) { $i = $i.InnerException }',
    '    if ($i -and [int64]($i.HRESULT -band 0xFFFFFFFF) -eq 0x80073D54) { $identity = $true }',
    '  }',
    '}',
  ]
  const gcRaw = [
    'try {',
    ...loadLines,
    ...candidateLoop,
    'if ($ok) { exit 0 }',
    'exit 1',
    '} catch { exit 1 }',
  ].join('\n')
  const parentRaw = [
    'try {',
    ...loadLines,
    ...candidateLoop,
    'if ($ok) { exit 0 }',
    'if (-not $identity) {',
    '  try { ("ALL_AUMIDS_FAILED " + ("HRESULT=0x{0:X8} MSG={1}" -f ([int64]($lastErr.HRESULT -band 0xFFFFFFFF)), $lastErr.Message) ) | Out-File -Encoding utf8 (Join-Path $env:TEMP "dsh-notify-toast-err.txt") -Force } catch {}',
    '  exit 2',
    '}',
    'try {',
    '  $gc = ' + psq('powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + b64(gcRaw)),
    '  $null = Invoke-CimMethod -Namespace root/cimv2 -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $gc }',
    '  exit 0',
    '} catch { exit 4 }',
    '} catch {',
    '  $i = $_.Exception; while ($i -and $i.InnerException) { $i = $i.InnerException }',
    '  try { ("HRESULT=0x{0:X8} MSG={1}" -f ([int64]($i.HRESULT -band 0xFFFFFFFF)), $i.Message) | Out-File -Encoding utf8 (Join-Path $env:TEMP "dsh-notify-toast-err.txt") -Force } catch {}',
    '  exit 3',
    '}',
  ].join('\n')
  return { parentRaw, gcRaw, parentB64: b64(parentRaw), gcB64: b64(gcRaw) }
}

// ---------- 会话标题解析(纯函数,可单测) ----------
// 多源回落:会话对象自带 title(同步,零竞态)→ titleCache(异步读结果)→ 顶层会话标题(子代理归属)。
export const resolveSessionTitle = (sid, sessionsById, titleCache, headerById) => {
  const objTitle = (s) => {
    if (!s) return ''
    if (typeof s.title === 'string' && s.title.trim()) return s.title.trim()
    if (s.header && typeof s.header.title === 'string' && s.header.title.trim()) return s.header.title.trim()
    return ''
  }
  const st = objTitle(sessionsById.get(sid))
  if (st) return st
  const ct = titleCache.get(sid)
  if (ct) return ct
  try {
    const root = topRootOf(sid, headerById)
    if (root && root !== sid) {
      const rt = objTitle(sessionsById.get(root)) || titleCache.get(root)
      if (rt) return rt
    }
  } catch { /* 归属尽力而为 */ }
  return ''
}
export const shortSid = (sid) => '会话 ' + String(sid).replace(/^session-/, '').slice(0, 8)

export default {
  name: 'dsh-notify',
  inject: ['webServer', 'timer', 'agents', 'sessions', 'sessionQuery'],

  apply(ctx) {
    let runningSessionIds = []
    let runningSid = ''
    let runningTitle = ''
    let pendingApprovalIds = []
    let approvalSid = ''
    let approvalTitle = ''
    let questionSessionIds = []
    let questionSid = ''
    let questionTitle = ''
    let testMode = 0 // 0=off, 1=approval, 2=done, 3=question(仅 /notify-test 可改,内存态)
    const approvalDecisions = {} // sid -> 'approved'|'denied'(approval/decided.data.outcome: allowed* = 通过)

    // ---------- 诊断(仅 /notify-debug 暴露;定位桌面端轮询不生效问题) ----------
    const dbg = {
      pollCount: 0,
      lastPollTs: 0,
      lastPollDurMs: 0,
      lastPollError: '',
      sessionsCount: 0,
      agentsRunningCount: 0,
      rawTimerBeats: 0, // 与 cordis interval 无关的 Node 原生心跳(对照基准)
      applyTs: Date.now(),
      ctxHasInterval: typeof ctx.interval,
      ctxHasTimeout: typeof ctx.timeout,
      watchSid: '', // /notify-debug?sid=... 指定观察的会话;空=自动取当前 running 会话
      lastTail: '',
    }
    try { const hb = setInterval(() => { dbg.rawTimerBeats++ }, 5000); if (typeof hb.unref === 'function') hb.unref() } catch (e) { dbg.rawTimerBeats = -1 }

    // ---------- Windows 系统通知(WinRT toast,后端直发) ----------
    // 根因:DSH 桌面壳 Electron 主进程未调用 app.setAppUserModelId(),渲染器
    //   new Notification() 在 Windows 上静默失败(无 toast)。浏览器旧环境无此问题。
    // 方案:插件后端(Node 进程)在事件边沿时 spawn powershell.exe 走
    //   WinRT ToastNotificationManager 直发 Windows 通知中心(AUMID 候选见 TOAST_AUMIDS)。
    //   与渲染器 Notification 并存:桌面端后者当前无效,浏览器端前者不存在(win32 守卫)。
    // 设置管理:与设置页「通知设置」同一套语义(master/approval/taskDone)。
    //   注入脚本在设置变化时 POST /notify-settings 上报;后端只接受桌面壳(Electron UA)
    //   的上报——WinRT 是宿主机本地通知,由本机桌面窗口的设置管辖。
    //   桌面窗口从未打开过 → 用默认值(全开);DSH 重启后内存清空,待页面重新上报。
    // 发送者名 = AUMID(通知中心直接显示 AUMID 本身)。候选列表见模块级 TOAST_AUMIDS:
    //   首选 'DSH 通知',WinRT 拒绝则回落 'DshNotify'。
    let toastPosted = 0
    let lastToastError = ''
    let lastToastSkip = ''
    const winSettings = { master: true, approval: 'always', approvalDone: 'always', taskDone: 'always', approvalCleanup: true, sessionBlacklist: [], version: 1 }
    let winSettingsSyncTs = 0
    const opsLog = [] // 通知操作日志(/notify-ops 诊断用;渲染器 POST 与本端 win-toast 共用)
    // 服务器端边沿检测基线(首拍不弹,避免启动时把既有状态当新事件)
    let edgeBaseline = false
    let prevApprovalIds = []
    let prevQuestionIds = []
    let prevRunningIds = []
    // ---------- 完成门控(v1.4.0:等 5s → 检测 → 干净即推;不确定则 10s 兜底) ----------
    // 时序(用户观察原话):"会话登记压缩-会话结束后我之前看过,都是立刻会进入压缩状态的,非常快"
    //   → 会话结束(集合边沿)后先等观察窗(默认 5s):要压缩的话,几秒内就进入"正在压缩"(inflight);
    //   → 观察窗满后做同拍三项检测:
    //       ④ 是否正在压缩?compaction/start 已见而 compaction/end 未见 ⇒ 正在压缩 ⇒ 不推
    //         (可读性:N1 侦察确认——start/end 事件配对即可判;用户"发信息会等待"等的就是此状态);
    //       ② 子代理是否全部结束?running 集合语义承载:任一在跑 → 该 sid 回集合 → hold 取消;
    //       ③ 后台作业是否全部结算?ctx.jobs 谱系枚举无 running/stopping 作业;
    //   → 三项全干净 ⇒ 立刻放行(完成边沿触发推送;服务端 WinRT 与 /notify-state 同源于暴露集合,两通道同口径);
    //   → 仍不确定(④ 见登记痕迹 request_compact 但压缩迟迟未启动、也无 start/end=压缩可能即将开始,
    //       或已被跳过/失败而无日志痕迹;③ 作业刚结算=唤醒可能将至)⇒ 兜底等待(默认 10s,
    //       v1.3.0 的 30s 弃用),超时后视同"可推"。
    // 依据:登记状态本体(armed)在 compactor 闭包 WeakMap 内不可直读(见 selfCompactState 注释),
    // 只能按事件流痕迹 + 窗口兜底;后台作业经宿主 ctx.jobs 服务读取
    // (dsh-jobs-local 随 dsh-base 注册于根作用域;取不到时降级为不判定)。
    const doneGate = new Map() // sid -> { heldSince, clearedAt, inflightSince, jobsHeld }
    const { watchMs: DONE_WATCH_MS, fallbackMs: DONE_FALLBACK_MS, inflightMs: DONE_INFLIGHT_GRACE_MS } = gateConfigFromEnv()
    let jobsSvc
    try { jobsSvc = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined } catch { jobsSvc = undefined }
    // cat: 'approval'(⏳审批/⏳回答,受 master+approval 管) | 'done'(✅完成,受 master+taskDone 管)
    const postWinToast = (title, body, cat) => {
      if (process.platform !== 'win32') return
      if (process.env.DSH_NOTIFY_NO_TOAST === '1') return
      if (!winSettings.master) { lastToastSkip = 'settings: master=off'; return }
      if (cat === 'approval' && winSettings.approval === 'off') { lastToastSkip = 'settings: approval=off'; return }
      if (cat === 'done' && winSettings.taskDone === 'off') { lastToastSkip = 'settings: taskDone=off'; return }
      lastToastSkip = ''
      try {
        const { parentRaw } = buildToastScripts(title, body, TOAST_AUMIDS)
        // 明文 -Command(而非 -EncodedCommand base64):完整脚本在进程列表直接可见,
        // 无"编码混淆"特征——规避 360 等杀软对 -EncodedCommand 的启发式误报。
        const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', parentRaw], { windowsHide: true, stdio: 'ignore' })
        p.on('error', (e) => { lastToastError = 'spawn: ' + e.message })
        p.on('close', (code) => {
          if (code !== 0) {
            let detail = ''
            try {
              const ef = (process.env.TEMP || process.env.TMP || '') + '\\dsh-notify-toast-err.txt'
              if (ef && existsSync(ef)) detail = readFileSync(ef, 'utf8').trim().slice(-200)
            } catch { /* 诊断尽力而为 */ }
            lastToastError = 'exit ' + code + (detail ? ' | ' + detail : '')
          } else {
            toastPosted++; opsLog.push({ kind: 'win-toast', ts: Date.now(), title })
          }
          if (opsLog.length > 50) opsLog.splice(0, opsLog.length - 50)
        })
        const kill = setTimeout(() => { try { p.kill() } catch (e) {} }, 20000)
        if (typeof kill.unref === 'function') kill.unref()
      } catch (e) {
        lastToastError = String(e && e.message || e)
      }
    }

    // readTitle 双通道:新版返回字符串,旧版返回 { title }
    const readTitle = (sid) =>
      Promise.resolve(ctx.sessionQuery.readTitle(sid))
        .then((t) => {
          if (typeof t === 'string') return t
          if (t && typeof t.title === 'string' && t.title.length) return t.title
          return ''
        })
        .catch(() => '')

    // ---------- 每 sid 会话标题(toast 正文显示) ----------
    // 问题:审批/问答边沿在 sid 首次出现的同一拍触发,而 readTitle 是异步的 → 标题未就绪,正文退化为会话 ID。
    // 修复:多源 + 延迟补偿:
    //   1) 同步源:会话对象自带 title 字段时直接取(零竞态);
    //   2) 异步缓存:readTitle 结果按 sid 缓存,后续命中即取;
    //   3) 顶层归属:子会话(子代理)无标题 → 取顶层会话标题(用户真正关心的是哪个主会话);
    //   4) 延迟补偿:边沿时标题未就绪 → 最多等 5s,超时回落"会话 <短ID>"。
    const titleCache = new Map() // sid -> title(异步读结果)
    const titleAttempts = new Map() // sid -> 尝试次数(读空允许重试,标题可能晚于首次读取生成)
    const ensureTitle = (sid) => {
      if (!sid || titleCache.has(sid)) return
      const n = titleAttempts.get(sid) ?? 0
      if (n >= 3) return
      titleAttempts.set(sid, n + 1)
      if (titleCache.size > 500) titleCache.delete(titleCache.keys().next().value)
      if (titleAttempts.size > 600) titleAttempts.delete(titleAttempts.keys().next().value)
      void readTitle(sid).then((t) => {
        if (!t) return
        titleCache.set(sid, t)
        // 读完成时同步 /notify-state 用的全局标题(保持旧契约的时序)
        if (sid === runningSid) runningTitle = t
        if (sid === approvalSid) approvalTitle = t
        if (sid === questionSid) questionTitle = t
      }).catch(() => {})
    }
    let titleFor = (sid) => '' // 每拍 poll 注入(依赖当拍的会话表/header 表)
    const deferredToasts = [] // { sid, titleText, cat, born }
    // 会话 ID 黑名单:去空白后全等匹配;命中 → 该会话完成时不发 WinRT 弹窗(审批/回答不受影响,与渲染端 onSessionDone 同口径)
    const sidBlacklisted = (sid) => {
      const bl = winSettings.sessionBlacklist
      if (!Array.isArray(bl) || !sid) return false
      const s = String(sid).trim()
      if (!s) return false
      return bl.some((x) => typeof x === 'string' && x.trim() === s)
    }
    const wantToast = (titleText, sid, cat, testLabel) => {
      if (sid.startsWith('test-')) { postWinToast(titleText, testLabel, cat); return }
      if (cat === 'done' && sidBlacklisted(sid)) return
      const t = titleFor(sid)
      if (t) postWinToast(titleText, t, cat)
      else deferredToasts.push({ sid, titleText, cat, born: Date.now() })
    }
    const flushDeferredToasts = () => {
      if (!deferredToasts.length) return
      const remain = []
      for (const d of deferredToasts) {
        if (d.cat === 'done' && sidBlacklisted(d.sid)) continue // 延迟期间进了黑名单 → 丢弃,不再补发
        const t = titleFor(d.sid)
        if (t) postWinToast(d.titleText, t, d.cat)
        else if (Date.now() - d.born > 5000) postWinToast(d.titleText, shortSid(d.sid), d.cat)
        else remain.push(d)
      }
      deferredToasts.length = 0
      deferredToasts.push(...remain)
    }

    const poll = () => {
      const t0 = Date.now()
      dbg.lastPollError = ''
      // 0) 活跃会话 → header 表(子代理谱系归属用)
      let sessions = []
      try { sessions = ctx.sessions.list() } catch (e) { dbg.lastPollError = 'sessions.list: ' + e.message }
      const headerById = new Map()
      const sessionsById = new Map()
      try {
        for (const s of sessions) {
          if (s && s.id) {
            headerById.set(s.id, s.header ?? {})
            sessionsById.set(s.id, s)
          }
        }
      } catch (e) { if (!dbg.lastPollError) dbg.lastPollError = 'headerById: ' + e.message }
      // 标题解析:同步源(会话对象自带 title)→ 异步缓存 → 顶层会话标题
      titleFor = (sid) => resolveSessionTitle(sid, sessionsById, titleCache, headerById)

      // 1) 运行中集合(完成通知的边沿源)—— 纯函数判定,见 computeRunningSet:
      //    主代理已结束但子代理未完 → 顶层 id 仍在集合 → 不发"会话完成";
      //    主代理与全部子代理都结束 → 边沿触发通知
      const liveAgents = []
      try {
        for (const agent of ctx.agents.list()) {
          if (!agent || agent.status !== 'running') continue
          liveAgents.push({ id: agent.id, status: agent.status, header: (agent.session && agent.session.header) || undefined })
        }
      } catch (e) { if (!dbg.lastPollError) dbg.lastPollError = 'agents.list: ' + e.message }
      try {
        runningSessionIds = computeRunningSet(liveAgents, headerById)
      } catch (e) { if (!dbg.lastPollError) dbg.lastPollError = 'runningSet: ' + e.message }
      // 1b) 完成门控:把"已离开 running 但尚待确认"的会话暂留在暴露集合(见 doneGate 注释)。
      //     短路次序(沿用 v1.3.0):集合边沿(①②已满足) → ④正在压缩(inflight)? → ③谱系内有无 running/stopping 作业?
      //     放行规则(v1.4.0):会话结束 → 先等观察窗(默认 5s) → 同拍三项检测(④/②/③)→ 全干净即放行(推送);
      //     窗外仍不确定(④登记痕迹未消费 / ③作业刚结算)→ 兜底(默认 10s)后放行。
      //     test- 调试 sid 不进门控。
      {
        const now = Date.now()
        // 重新 running(被压缩/作业唤醒)→ 会话未完,先取消 hold(与下方候补集互斥,先行清理)
        for (const sid of [...doneGate.keys()]) if (runningSessionIds.includes(sid)) doneGate.delete(sid)
        const candidates = new Set()
        for (const sid of prevRunningIds) if (!runningSessionIds.includes(sid) && !sid.startsWith('test-')) candidates.add(sid)
        for (const sid of doneGate.keys()) if (!runningSessionIds.includes(sid)) candidates.add(sid)
        if (candidates.size) {
          const exposed = new Set(runningSessionIds)
          for (const sid of candidates) {
            const g = doneGate.get(sid) ?? { heldSince: now, clearedAt: null, inflightSince: null, jobsHeld: false }
            // ④ 正在压缩:compaction/start 已见而 end 未见 ⇒ 正在压缩 ⇒ 不推(用户观察:压缩进入非常快,
            //    要压缩的在观察窗内几乎必然现形;此处持续 hold 到 end,卡死护栏见 DONE_INFLIGHT_GRACE_MS)
            const pc = selfCompactState(readEvents(sessionsById.get(sid)))
            let pending = false
            if (pc === 'inflight') {
              if (g.inflightSince === null) g.inflightSince = now
              pending = now - g.inflightSince <= DONE_INFLIGHT_GRACE_MS
            } else {
              g.inflightSince = null
            }
            // ③ 后台工作:ctx.jobs 按谱系枚举(短路:压缩 in-flight 时不再查作业)
            let pj = false
            if (!pending && jobsSvc && typeof jobsSvc.list === 'function') {
              for (const lsid of lineageSids(sid, sessions, headerById)) {
                let js
                try { js = jobsSvc.list(lsid) } catch { continue }
                if (Array.isArray(js) && js.some((j) => j && j.owner === lsid && (j.status === 'running' || j.status === 'stopping'))) { pj = true; break }
              }
            }
            if (pending || pj) {
              if (pj) g.jobsHeld = true // 待处理工作中 → 持续 hold(唤醒则重新 running,上方先行清理)
              exposed.add(sid)
              doneGate.set(sid, g)
              continue
            }
            // v1.4.0:会话结束后先等观察窗(用户观察:登记→进入压缩"立刻、非常快",5s 足以让 inflight 现形)
            if (now - g.heldSince < DONE_WATCH_MS) {
              exposed.add(sid)
              doneGate.set(sid, g)
              continue
            }
            // 观察窗满,同拍三项检测收口:②由集合承载(未回 running=子代理全结束且无复跑)、
            // ④非正在压缩、③作业已结算(上方已短路)。仍不确定(④登记痕迹未消费=压缩可能即将开始
            // 或已跳过/失败无痕迹;③作业刚结算=唤醒可能将至)→ 兜底等待(默认 10s),超时视同可推;
            // 否则三项全干净 → 立刻放行,完成边沿触发推送
            if (pc === 'request' || g.jobsHeld) {
              if (g.clearedAt === null) g.clearedAt = now
              if (now - g.clearedAt < DONE_FALLBACK_MS) {
                exposed.add(sid)
                doneGate.set(sid, g)
                continue
              }
            }
            doneGate.delete(sid) // 三项全干净(或兜底期满仍无活动)→ 会话确已结束,放行
          }
          runningSessionIds = [...exposed]
        }
      }
      const rsid = runningSessionIds[0] ?? ''
      if (rsid) {
        if (rsid !== runningSid) runningSid = rsid
        const rt = titleFor(rsid)
        if (rt) runningTitle = rt
        ensureTitle(rsid)
      }

      // 2) 待审批会话集合(末尾 approval/asked 且其后无 approval/decided)
      const approvals = []
      let tailInfo = ''
      try {
        for (const session of sessions) {
          const evs = readEvents(session)
          if (evs.length && session.id === dbg.watchSid) {
            tailInfo = 'sid=' + session.id + ' n=' + evs.length + ' tail=' + evs[evs.length - 1].type
          }
          for (let i = evs.length - 1; i >= 0; i--) {
            const t = evs[i].type
            if (t === 'approval/asked') { approvals.push(session.id); break }
            if (t === 'approval/decided') {
              const out = evs[i].data && typeof evs[i].data.outcome === 'string' ? evs[i].data.outcome : ''
              approvalDecisions[session.id] = out.startsWith('allowed') ? 'approved' : 'denied'
              break
            }
          }
        }
      } catch (e) { if (!dbg.lastPollError) dbg.lastPollError = 'approvals: ' + e.message }
      const dk = Object.keys(approvalDecisions)
      if (dk.length > 100) dk.slice(0, 50).forEach((k) => delete approvalDecisions[k])
      pendingApprovalIds = approvals
      const asid = approvals[0] ?? ''
      if (asid) {
        if (asid !== approvalSid) approvalSid = asid
        const at = titleFor(asid)
        if (at) approvalTitle = at
        ensureTitle(asid)
      }

      // 3) 待回答会话集合(tool/call ask_user_question 无同 callId 的 tool/result)
      const questions = []
      try {
        for (const session of sessions) {
          const evs = readEvents(session)
          let pending = false
          for (let i = 0; i < evs.length; i++) {
            const d = evs[i].type === 'tool/call' ? evs[i].data : null
            if (!d || d.name !== 'ask_user_question' || !d.callId) continue
            const cid = d.callId
            let resolved = false
            for (let j = i + 1; j < evs.length; j++) {
              const rd = evs[j].type === 'tool/result' ? evs[j].data : null
              if (rd && rd.message && rd.message.source && rd.message.source.callId === cid) { resolved = true; break }
            }
            if (!resolved) { pending = true; break }
          }
          if (pending) questions.push(session.id)
        }
      } catch (e) { if (!dbg.lastPollError) dbg.lastPollError = 'questions: ' + e.message }
      questionSessionIds = questions
      const qsid = questions[0] ?? ''
      if (qsid) {
        if (qsid !== questionSid) questionSid = qsid
        const qt = titleFor(qsid)
        if (qt) questionTitle = qt
        ensureTitle(qsid)
      }

      // 4) 服务器端边沿检测 → Windows 系统通知(WinRT 直发)
      //    与渲染器注入脚本的边沿语义一致:新出现的待审批/待回答、以及会话从运行中消失(完成)。
      //    首拍只记基线不弹(避免 DSH 启动时把既有挂起态当新事件)。
      //    用"有效集合"(含 testMode 调试态)—— 与 /notify-state 口径一致,让 /notify-test 能端到端验证 WinRT
      const effApproval = testMode === 1 ? [...pendingApprovalIds, 'test-approval'] : pendingApprovalIds
      const effQuestion = testMode === 3 ? [...questionSessionIds, 'test-question'] : questionSessionIds
      const effRunning = testMode === 2 ? [...runningSessionIds, 'test-done'] : runningSessionIds
      // 标题预热:为所有有效 sid(及其顶层)发起异步标题读,供延迟补偿与后续命中
      for (const sid of new Set([...effApproval, ...effQuestion, ...effRunning])) {
        ensureTitle(sid)
        try { const r = topRootOf(sid, headerById); if (r && r !== sid) ensureTitle(r) } catch { /* 尽力而为 */ }
      }
      // 延迟补偿:上一拍标题未就绪的通知,现在补发(或超时回落)
      flushDeferredToasts()
      if (edgeBaseline) {
        for (const sid of effApproval) if (!prevApprovalIds.includes(sid)) wantToast('⏳ DSH 会话等待审批', sid, 'approval', '(测试)等待审批')
        for (const sid of effQuestion) if (!prevQuestionIds.includes(sid)) wantToast('⏳ DSH 会话等待回答', sid, 'approval', '(测试)等待回答')
        for (const sid of prevRunningIds) if (!effRunning.includes(sid)) wantToast('✅ DSH 会话已完成', sid, 'done', '(测试)任务完成')
      }
      edgeBaseline = true
      prevApprovalIds = [...effApproval]
      prevQuestionIds = [...effQuestion]
      prevRunningIds = [...effRunning]

      // 5) 诊断计数
      if (!dbg.watchSid && rsid) dbg.watchSid = rsid
      dbg.pollCount++
      dbg.lastPollTs = Date.now()
      dbg.lastPollDurMs = Date.now() - t0
      dbg.sessionsCount = sessions.length
      dbg.agentsRunningCount = liveAgents.length
      dbg.lastTail = tailInfo
      dbg.toastPosted = toastPosted
      dbg.lastToastError = lastToastError
    }

    ctx.interval(poll, 1000)
    poll()

    // 4) 只读状态端点(手机端轮询源)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-state',
      handler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        const running = runningSessionIds.length > 0 || testMode === 2
        const pendingApproval = pendingApprovalIds.length > 0 || testMode === 1
        const pendingQuestion = questionSessionIds.length > 0 || testMode === 3
        res.end(JSON.stringify({
          running,
          pendingApproval,
          runningTitle: testMode === 2 && !runningTitle ? '(测试)任务完成' : runningTitle,
          approvalTitle: testMode === 1 && !approvalTitle ? '(测试)等待审批' : approvalTitle,
          runningSessionIds: testMode === 2 ? [...runningSessionIds, 'test-done'] : runningSessionIds,
          approvalSessionIds: testMode === 1 ? [...pendingApprovalIds, 'test-approval'] : pendingApprovalIds,
          questionSessionIds: testMode === 3 ? [...questionSessionIds, 'test-question'] : questionSessionIds,
          questionTitle: testMode === 3 && !questionTitle ? '(测试)等待回答' : questionTitle,
          pendingQuestion,
          decisions: testMode === 1 ? { ...approvalDecisions, 'test-approval': 'approved' } : approvalDecisions,
        }))
      },
    }))

    // 5) 四态调试端点(仅改内存标志,off 复原)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-test',
      handler: (req, res) => {
        const qi = (req.url || '/').indexOf('?')
        const q = qi >= 0 ? new URLSearchParams((req.url || '/').slice(qi + 1)) : new URLSearchParams()
        const mode = q.get('mode') || 'off'
        testMode = mode === 'approval' ? 1 : mode === 'done' ? 2 : mode === 'question' ? 3 : 0
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('ok: ' + mode + ' (testMode=' + testMode + ')')
      },
    }))

    // 5a) toast 手动测试端点(重启后验证 spawn 链/定位 AUMID 污染)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-test-toast',
      handler: (req, res) => {
        const qi = (req.url || '/').indexOf('?')
        const q = qi >= 0 ? new URLSearchParams((req.url || '/').slice(qi + 1)) : new URLSearchParams()
        postWinToast('⏳ DSH 会话等待审批', q.get('body') || '(测试)手动触发的 WinRT toast · 结果见 /notify-debug 的 lastToastError', 'approval')
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('ok: win-toast 已发起(结果稍候在 /notify-debug 查看 toastPosted / lastToastError)')
      },
    }))

    // 5b) 设置同步(注入脚本上报;仅桌面壳 UA 生效 → 管理 WinRT toast)
    // body 上限 8192 字节:客户端 syncSettings 按此上限倒推字节预算、发送前截断黑名单(过长部分生效);
    // 此处超限 req.destroy() 属兜底(客户端截断后正常不应触发)
    const SETTINGS_BODY_MAX_BYTES = 8192
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-settings',
      handler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        if (req.method !== 'POST') return
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > SETTINGS_BODY_MAX_BYTES) req.destroy() })
        req.on('end', () => {
          try {
            const j = JSON.parse(body || '{}')
            if (classifyPageUa(req.headers['user-agent'] || '') !== 'desktop-shell') return
            if (typeof j.master === 'boolean') winSettings.master = j.master
            if (['always', 'silent', 'off'].indexOf(j.approval) >= 0) winSettings.approval = j.approval
            if (['always', 'off'].indexOf(j.approvalDone) >= 0) winSettings.approvalDone = j.approvalDone
            if (['always', 'silent', 'off'].indexOf(j.taskDone) >= 0) winSettings.taskDone = j.taskDone
            if (typeof j.approvalCleanup === 'boolean') winSettings.approvalCleanup = j.approvalCleanup
            // sessionBlacklist 受上方 8192 字节 body 上限(SETTINGS_BODY_MAX_BYTES)约束:
            // 客户端 syncSettings 已按字节预算发送前截断(过长部分生效);此处仍超限则 destroy 丢弃(兜底)
            if (Array.isArray(j.sessionBlacklist)) {
              winSettings.sessionBlacklist = [...new Set(j.sessionBlacklist
                .filter((x) => typeof x === 'string')
                .map((x) => x.trim())
                .filter((x) => x !== ''))]
                .slice(0, 50)
            }
            winSettingsSyncTs = Date.now()
          } catch { /* 忽略坏帧 */ }
        })
      },
    }))

    // 6) 通知操作日志(注入脚本上报 + 本端 win-toast;内存环形 50 条;opsLog 在上方声明)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-ops',
      handler: (req, res) => {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy() })
          req.on('end', () => {
            try {
              const j = JSON.parse(body || '{}')
              j.at = new Date().toISOString()
              opsLog.push(j)
              if (opsLog.length > 50) opsLog.shift()
            } catch { /* 忽略坏帧 */ }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          })
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, ops: opsLog }))
      },
    }))

    // 7) 注入脚本冒烟报告
    let smokeReport = null
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-smoke',
      handler: (req, res) => {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy() })
          req.on('end', () => {
            try { smokeReport = { ...(JSON.parse(body || '{}')), at: new Date().toISOString() } } catch { /* 忽略坏帧 */ }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          })
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(smokeReport ?? { ok: true, note: '尚无冒烟报告(页面未加载过?)' }))
      },
    }))

    // 7b) 运行时诊断(定位桌面端轮询/检测问题)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-debug',
      handler: (req, res) => {
        const qi = (req.url || '/').indexOf('?')
        const q = qi >= 0 ? new URLSearchParams((req.url || '/').slice(qi + 1)) : new URLSearchParams()
        const sid = q.get('sid')
        if (sid) dbg.watchSid = sid
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({
          dbg: { ...dbg, winSettings: { ...winSettings }, winSettingsSyncTs, lastToastSkip, titleCacheSize: titleCache.size, deferredToasts: deferredToasts.length, doneGate: Object.fromEntries(doneGate), gateMs: { watch: DONE_WATCH_MS, fallback: DONE_FALLBACK_MS, inflight: DONE_INFLIGHT_GRACE_MS }, jobsSvcAvailable: !!(jobsSvc && typeof jobsSvc.list === 'function') },
          pendingApprovalIds,
          runningSessionIds,
          questionSessionIds,
          approvalDecisions,
          testMode,
        }, null, 1))
      },
    }))

    // 8) 页面注入(双通道;注入脚本自带幂等守卫,重复注入无副作用)
    //    a) 新版 DSH:结构化 script 行 → 桌面壳(启动 payload 携带行,页面端执行)
    //       与浏览器壳(renderIndex 渲染进 index.html)都生效
    try {
      ctx.on('webserver/index-inject', (table) => {
        if (Array.isArray(table)) table.push({ kind: 'script', placement: 'head', text: INJECT_JS })
      })
    } catch (e) { /* 旧版 DSH 无此事件 → 静默回落 tapIndex */ }
    //    b) 旧版 DSH 回落:tapIndex 原始转换(新版浏览器壳与 a 并存,幂等守卫去重)
    ctx.effect(() => ctx.webServer.tapIndex((html) => {
      if (html.indexOf('dsh-notify-inject') >= 0) return html
      const tag = '<script id="dsh-notify-inject">' + INJECT_JS + '</' + 'script>'
      return html.indexOf('</head>') >= 0 ? html.replace('</head>', tag + '\n</head>') : html + tag
    }))
  },
}
