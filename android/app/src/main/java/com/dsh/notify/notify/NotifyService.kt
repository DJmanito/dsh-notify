package com.dsh.notify.notify

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.util.concurrent.TimeUnit
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.dsh.notify.AppVisibility
import com.dsh.notify.R
import com.dsh.notify.Settings
import com.dsh.notify.SettingsSync
import com.dsh.notify.work.FallbackWorker
import com.dsh.notify.notify.fetchNotifyFrame
import java.util.concurrent.Executors

/**
 * 通知监控前台服务:
 * - foregroundServiceType=dataSync;默认 20s 轮询 /notify-state(可配 10-60s);
 * - 喂 [NotifyStateMachine](边沿触发/会话级去重/聚合)→ [NotificationHelper] 推送;
 * - App 前台可见时静默(不弹);
 * - Android 15 dataSync 6h 超时 → onTimeout 停止,交 WorkManager 15 分钟兜底;
 * - 状态持久化 [NotifyStateStore]:进程被杀后重建,基线首帧不重放。
 */
class NotifyService : android.app.Service() {

    companion object {
        private const val FGS_ID = 1
        const val WORK_NAME = "dsh-notify-fallback"

        /** 服务存活标志(同进程):MainActivity.onResume 自恢复用。进程被杀后标志归零 → 下次打开 App 自动重拉。 */
        @Volatile
        var isRunning = false
            private set

        fun startAndSchedule(c: Context, source: String) {
            LogBus.ok("FGS START requested (source=$source, isRunning=$isRunning)")
            try {
                ensureChannels(c)
                startInternal(c)
                reschedule(c)
                LogBus.ok("FGS START dispatched (source=$source)")
            } catch (e: Exception) {
                LogBus.error("FGS START FAILED (source=$source): ${e.javaClass.simpleName}: ${e.message}")
            }
        }

        fun stopAndCancel(c: Context) {
            LogBus.ok("FGS STOP requested")
            c.stopService(Intent(c, NotifyService::class.java))
            WorkManager.getInstance(c).cancelUniqueWork(WORK_NAME)
        }

        fun reschedule(c: Context) {
            val req = PeriodicWorkRequestBuilder<FallbackWorker>(15, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(c)
                .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
        }

        private fun startInternal(c: Context) {
            ContextCompat.startForegroundService(c, Intent(c, NotifyService::class.java))
        }

        fun ensureChannels(c: Context) = NotificationHelper.ensureChannels(c)
    }

    /** Android 15 dataSync 前台服务 6h 上限 → 提前 5 分钟自停,交 WorkManager 15 分钟兜底。 */
    private val MAX_FGS_MS = TimeUnit.HOURS.toMillis(6) - TimeUnit.MINUTES.toMillis(5)

    private val executor = Executors.newSingleThreadScheduledExecutor()

    /**
     * 注意:不能在字段初始化器里用 this 当 Context——Service 构造时 attach() 尚未调用,
     * ContextWrapper.mBase 为 null,getSharedPreferences 会 NPE。延迟到 onCreate 初始化。
     */
    private lateinit var stateMachine: NotifyStateMachine

    // 轮询循环全在后台线程自调度(主线程 Handler 链在主线程被卡时轮询会静默断流)。循环若死亡必打 POLL LOOP DEAD。
    @Volatile
    private var loopAlive = false
    private var pollCount = 0
    @Volatile
    private var lastSettings: SettingsSync.ServerSettings = SettingsSync.ServerSettings.DEFAULT

    private val pollLoop = object : Runnable {
        override fun run() {
            if (!loopAlive) return
            try {
                pollCount++
                pollOnceInline(pollCount)
                // 轮询间隔 = 本地设置(默认值随安装,范围 5-60)
                val iv = lastSettings.pollInterval.coerceIn(5, 60) * 1000L
                executor.schedule(this, iv, TimeUnit.MILLISECONDS)
            } catch (e: Exception) {
                LogBus.error("POLL LOOP DEAD: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        LogBus.ok("SERVICE START (pid=${android.os.Process.myPid()}, 轮询间隔=${Settings.pollIntervalSec(this)}s)")
        if (!::stateMachine.isInitialized) {
            stateMachine = NotifyStateMachine().also { NotifyStateStore.loadInto(this, it) }
        }
        val n = NotificationCompat.Builder(this, NotificationHelper.CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.fgs_title))
            .setContentText(getString(R.string.fgs_text))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(FGS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(FGS_ID, n)
        }
        if (!loopAlive) {
            loopAlive = true
            executor.execute(pollLoop)
            LogBus.ok("POLL LOOP started (后台线程)")
        }
        // 6h 自停同样移出主线程(主线程被卡时 postDelayed 不生效)
        executor.schedule({ stopSelf() }, MAX_FGS_MS, TimeUnit.MILLISECONDS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop") {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    private fun pollOnceInline(count: Int) {
        val baseUrl = Settings.baseUrl(this)
        if (!Settings.hasServer(this)) {
            LogBus.error("POLL #$count SKIP: 未配置服务器")
            return
        }
        // 读本地设置(D5:两端各自本地保存,无网络往返)
        lastSettings = SettingsSync.fetch(this)
        val st = lastSettings
        val t0 = System.currentTimeMillis()
        val frame = try {
            fetchNotifyFrame(baseUrl)
        } catch (e: Exception) {
            LogBus.error("POLL #$count FAIL ${System.currentTimeMillis() - t0}ms: ${e.javaClass.simpleName} ${e.message}")
            return
        }
        if (frame == null) {
            LogBus.error("POLL #$count FAIL ${System.currentTimeMillis() - t0}ms: 非 200 或解析失败 url=$baseUrl")
            return
        }
        val events = synchronized(stateMachine) { stateMachine.update(frame) }
        Settings.touchPoll(this)
        NotifyStateStore.save(this, stateMachine)
        LogBus.ok(
            "POLL #$count OK ${System.currentTimeMillis() - t0}ms running=${frame.runningSessionIds.size} " +
                "approval=${frame.approvalSessionIds.size} question=${frame.questionSessionIds.size} " +
                "events=${events.size} master=${st.master}"
        )
        if (events.isNotEmpty()) {
            LogBus.ok("EDGE: " + events.joinToString { it::class.simpleName ?: "?" })
            if (AppVisibility.isAppVisible) {
                LogBus.ok("SILENT: App 前台可见,不发通知(状态已推进)——要收通知请把 App 切回桌面")
                return
            }
            EventPoster.post(this, st, events, frame.decisions)
        }
    }

    override fun onDestroy() {
        loopAlive = false
        executor.shutdownNow()
        isRunning = false
        LogBus.ok("SERVICE STOP")
        super.onDestroy()
    }
}

/**
 * 状态持久化:进程被杀/服务重启后,状态机从上次快照恢复基线(避免重放旧状态为新通知)。
 */
object NotifyStateStore {
    private const val FILE = "dsh_notify_state"

    fun save(c: Context, sm: NotifyStateMachine) {
        val s = sm.snapshot()
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString("snap", s).apply()
    }

    fun loadInto(c: Context, sm: NotifyStateMachine) {
        val s = c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString("snap", null) ?: return
        sm.restore(s)
    }
}
