package com.dsh.notify.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.dsh.notify.AppVisibility
import com.dsh.notify.Settings
import com.dsh.notify.SettingsSync
import com.dsh.notify.notify.EventPoster
import com.dsh.notify.notify.LogBus
import com.dsh.notify.notify.NotifyStateMachine
import com.dsh.notify.notify.NotifyStateStore
import com.dsh.notify.notify.fetchNotifyFrame

/**
 * WorkManager 15 分钟兜底:
 * - 前台服务心跳新鲜(lastPollAt 在 2 个轮询周期内)→ 服务存活,跳过(避免双源竞争);
 * - 服务不在 → 单次轮询 + 同一状态机(持久化快照)补位;
 * - 不常驻通知;轮询失败(Result.retry)下个周期再试。
 */
class FallbackWorker(c: Context, p: WorkerParameters) : CoroutineWorker(c, p) {

    override suspend fun doWork(): Result {
        // 心跳新鲜阈值 = 120s(服务轮询间隔最大 60s 的 2 倍,避免与存活服务双源竞争)
        val freshMs = 120_000L
        if (System.currentTimeMillis() - Settings.lastPollAt(applicationContext) < freshMs) {
            LogBus.ok("WORKER SKIP: 前台服务心跳新鲜")
            return Result.success() // 前台服务存活
        }
        val base = Settings.baseUrl(applicationContext)
        if (!Settings.hasServer(applicationContext)) {
            LogBus.ok("WORKER SKIP: 未配置服务器")
            return Result.success()
        }
        val frame = runCatching { fetchNotifyFrame(base) }.getOrNull()
        if (frame == null) {
            LogBus.error("WORKER POLL FAIL: 网络/解析失败,下个周期重试")
            return Result.retry()
        }
        val sm = NotifyStateMachine()
        NotifyStateStore.loadInto(applicationContext, sm)
        val events = sm.update(frame)
        Settings.touchPoll(applicationContext)
        NotifyStateStore.save(applicationContext, sm)
        val st = SettingsSync.fetch(applicationContext)
        LogBus.ok("WORKER POLL OK events=${events.size} master=${st.master}")
        if (!AppVisibility.isAppVisible) {
            EventPoster.post(applicationContext, st, events, frame.decisions)
        } else {
            LogBus.ok("WORKER SILENT: App 前台可见")
        }
        return Result.success()
    }
}
