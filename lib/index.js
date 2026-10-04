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
    var s = { master: true, approval: 'always', approvalDone: 'off', taskDone: 'always', approvalCleanup: true, version: 1 }
    try {
      var raw = localStorage.getItem(LS_KEY)
      if (raw) {
        var p = JSON.parse(raw)
        if (typeof p.master === 'boolean') s.master = p.master
        if (['always', 'silent', 'off'].indexOf(p.approval) >= 0) s.approval = p.approval
        if (['always', 'off'].indexOf(p.approvalDone) >= 0) s.approvalDone = p.approvalDone
        if (['always', 'silent', 'off'].indexOf(p.taskDone) >= 0) s.taskDone = p.taskDone
        if (typeof p.approvalCleanup === 'boolean') s.approvalCleanup = p.approvalCleanup
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
    var t = settings.taskDone === 'silent' ? 'done-' + sid : 'done-' + sid + '-' + Date.now()
    notify('✅ DSH 会话已完成', title || '会话已完成', t)
  }

  // 设置同步:把本页设置上报后端(变更时触发),让 WinRT 直发通道受同一套设置管理。
  // 后端按 UA 归因:桌面壳的页面上报 = 宿主机设置;远程浏览器/手机的上报被忽略。
  var lastSyncedSig = ''
  function syncSettings() {
    if (!settings) return
    var sig = [settings.master, settings.approval, settings.approvalDone, settings.taskDone, settings.approvalCleanup].join('|')
    if (sig === lastSyncedSig) return
    lastSyncedSig = sig
    fetch('/notify-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }).catch(function () {})
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
export const buildToastScripts = (title, body, aumid = 'DJmanito.DshNotify') => {
  const xml = buildToastXml(title, body)
  const b64 = (s) => Buffer.from(s, 'utf16le').toString('base64')
  const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const toastCore = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$x.LoadXml(' + psq(xml) + ')',
    '$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(' + psq(aumid) + ')',
    '$n.Show((New-Object Windows.UI.Notifications.ToastNotification $x))',
  ].join('\n')
  const gcRaw = 'try {\n' + toastCore + '\nexit 0\n} catch { exit 1 }'
  const parentRaw = [
    'try {',
    toastCore,
    'exit 0',
    '} catch {',
    '  $i = $_.Exception; while ($i -and $i.InnerException) { $i = $i.InnerException }',
    '  try { ("HRESULT=0x{0:X8} MSG={1}" -f ([int64]($i.HRESULT -band 0xFFFFFFFF)), $i.Message) | Out-File -Encoding utf8 (Join-Path $env:TEMP "dsh-notify-toast-err.txt") -Force } catch {}',
    '  if ([int64]($i.HRESULT -band 0xFFFFFFFF) -ne 0x80073D54) { exit 2 }',
    '  try {',
    '    $gc = ' + psq('powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + b64(gcRaw)),
    '    $null = Invoke-CimMethod -Namespace root/cimv2 -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $gc }',
    '    exit 0',
    '  } catch { exit 4 }',
    '}',
  ].join('\n')
  return { parentRaw, gcRaw, parentB64: b64(parentRaw), gcB64: b64(gcRaw) }
}

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
    //   WinRT ToastNotificationManager 直发 Windows 通知中心(AUMID=DJmanito.DshNotify)。
    //   与渲染器 Notification 并存:桌面端后者当前无效,浏览器端前者不存在(win32 守卫)。
    // 设置管理:与设置页「通知设置」同一套语义(master/approval/taskDone)。
    //   注入脚本在设置变化时 POST /notify-settings 上报;后端只接受桌面壳(Electron UA)
    //   的上报——WinRT 是宿主机本地通知,由本机桌面窗口的设置管辖。
    //   桌面窗口从未打开过 → 用默认值(全开);DSH 重启后内存清空,待页面重新上报。
    const TOAST_AUMID = 'DJmanito.DshNotify'
    let toastPosted = 0
    let lastToastError = ''
    let lastToastSkip = ''
    const winSettings = { master: true, approval: 'always', approvalDone: 'always', taskDone: 'always', approvalCleanup: true, version: 1 }
    let winSettingsSyncTs = 0
    const opsLog = [] // 通知操作日志(/notify-ops 诊断用;渲染器 POST 与本端 win-toast 共用)
    // 服务器端边沿检测基线(首拍不弹,避免启动时把既有状态当新事件)
    let edgeBaseline = false
    let prevApprovalIds = []
    let prevQuestionIds = []
    let prevRunningIds = []
    // cat: 'approval'(⏳审批/⏳回答,受 master+approval 管) | 'done'(✅完成,受 master+taskDone 管)
    const postWinToast = (title, body, cat) => {
      if (process.platform !== 'win32') return
      if (process.env.DSH_NOTIFY_NO_TOAST === '1') return
      if (!winSettings.master) { lastToastSkip = 'settings: master=off'; return }
      if (cat === 'approval' && winSettings.approval === 'off') { lastToastSkip = 'settings: approval=off'; return }
      if (cat === 'done' && winSettings.taskDone === 'off') { lastToastSkip = 'settings: taskDone=off'; return }
      lastToastSkip = ''
      try {
        const { parentB64 } = buildToastScripts(title, body, TOAST_AUMID)
        const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', parentB64], { windowsHide: true, stdio: 'ignore' })
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

    const poll = () => {
      const t0 = Date.now()
      dbg.lastPollError = ''
      // 0) 活跃会话 → header 表(子代理谱系归属用)
      let sessions = []
      try { sessions = ctx.sessions.list() } catch (e) { dbg.lastPollError = 'sessions.list: ' + e.message }
      const headerById = new Map()
      try {
        for (const s of sessions) {
          if (s && s.id) headerById.set(s.id, s.header ?? {})
        }
      } catch (e) { if (!dbg.lastPollError) dbg.lastPollError = 'headerById: ' + e.message }

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
      const rsid = runningSessionIds[0] ?? ''
      if (rsid && rsid !== runningSid) {
        runningSid = rsid
        void readTitle(rsid).then((t) => { if (t) runningTitle = t })
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
      if (asid && asid !== approvalSid) {
        approvalSid = asid
        void readTitle(asid).then((t) => { if (t) approvalTitle = t })
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
      if (qsid && qsid !== questionSid) {
        questionSid = qsid
        void readTitle(qsid).then((t) => { if (t) questionTitle = t })
      }

      // 4) 服务器端边沿检测 → Windows 系统通知(WinRT 直发)
      //    与渲染器注入脚本的边沿语义一致:新出现的待审批/待回答、以及会话从运行中消失(完成)。
      //    首拍只记基线不弹(避免 DSH 启动时把既有挂起态当新事件)。
      //    用"有效集合"(含 testMode 调试态)—— 与 /notify-state 口径一致,让 /notify-test 能端到端验证 WinRT
      const effApproval = testMode === 1 ? [...pendingApprovalIds, 'test-approval'] : pendingApprovalIds
      const effQuestion = testMode === 3 ? [...questionSessionIds, 'test-question'] : questionSessionIds
      const effRunning = testMode === 2 ? [...runningSessionIds, 'test-done'] : runningSessionIds
      if (edgeBaseline) {
        for (const sid of effApproval) if (!prevApprovalIds.includes(sid)) postWinToast('⏳ DSH 会话等待审批', approvalTitle || (sid === 'test-approval' ? '(测试)等待审批' : sid), 'approval')
        for (const sid of effQuestion) if (!prevQuestionIds.includes(sid)) postWinToast('⏳ DSH 会话等待回答', questionTitle || (sid === 'test-question' ? '(测试)等待回答' : sid), 'approval')
        for (const sid of prevRunningIds) if (!effRunning.includes(sid)) postWinToast('✅ DSH 会话已完成', runningTitle || (sid === 'test-done' ? '(测试)任务完成' : sid), 'done')
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
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-settings',
      handler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        if (req.method !== 'POST') return
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy() })
        req.on('end', () => {
          try {
            const j = JSON.parse(body || '{}')
            if (classifyPageUa(req.headers['user-agent'] || '') !== 'desktop-shell') return
            if (typeof j.master === 'boolean') winSettings.master = j.master
            if (['always', 'silent', 'off'].indexOf(j.approval) >= 0) winSettings.approval = j.approval
            if (['always', 'off'].indexOf(j.approvalDone) >= 0) winSettings.approvalDone = j.approvalDone
            if (['always', 'silent', 'off'].indexOf(j.taskDone) >= 0) winSettings.taskDone = j.taskDone
            if (typeof j.approvalCleanup === 'boolean') winSettings.approvalCleanup = j.approvalCleanup
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
          dbg: { ...dbg, winSettings: { ...winSettings }, winSettingsSyncTs, lastToastSkip },
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
