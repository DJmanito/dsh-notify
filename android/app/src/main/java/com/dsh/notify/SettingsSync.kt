package com.dsh.notify

/**
 * 手机端通知设置存储门面(SharedPreferences;两端各自本地保存,与 PC 端不同步)。
 * fetch/post 均为同步本地读写,任意线程可调。
 * 字段契约与 PC 端一致:master/approval/approvalDone/taskDone/approvalCleanup(/pollInterval 手机独有)。
 */
object SettingsSync {

    data class ServerSettings(
        val master: Boolean,
        val approval: String,      // always|silent|off(等待审批/问答共用)
        val approvalDone: String,  // always|off(审批/问答状态)
        val taskDone: String,      // always|silent|off(任务完成)
        val approvalCleanup: Boolean, // 完成审批/问答时撤回等待通知
        val pollInterval: Int,     // 秒,手机端轮询(5-60)
        val version: Int,
    ) {
        companion object {
            val DEFAULT = ServerSettings(true, "always", "off", "always", true, 10, 1)
        }
    }

    private const val FILE = "dsh_remote_prefs"

    private fun prefs(c: android.content.Context) =
        c.getSharedPreferences(FILE, android.content.Context.MODE_PRIVATE)

    /** 读取本地设置(同步)。 */
    fun fetch(c: android.content.Context): ServerSettings = ServerSettings(
        master = prefs(c).getBoolean("master", true),
        approval = prefs(c).getString("approval", "always") ?: "always",
        approvalDone = prefs(c).getString("approvalDone", "off") ?: "off",
        taskDone = prefs(c).getString("taskDone", "always") ?: "always",
        approvalCleanup = prefs(c).getBoolean("approvalCleanup", true),
        pollInterval = prefs(c).getInt("pollIntervalSec", 10).coerceIn(5, 60),
        version = 1,
    )

    /** 局部修改本地设置(同步),返回最新完整设置。 */
    fun post(c: android.content.Context, patch: Map<String, Any>): ServerSettings {
        val e = prefs(c).edit()
        for ((k, v) in patch) {
            when (k) {
                "master" -> if (v is Boolean) e.putBoolean("master", v)
                "approval" -> if (v is String && v in listOf("always", "silent", "off")) e.putString("approval", v)
                "approvalDone" -> if (v is String && v in listOf("always", "off")) e.putString("approvalDone", v)
                "taskDone" -> if (v is String && v in listOf("always", "silent", "off")) e.putString("taskDone", v)
                "approvalCleanup" -> if (v is Boolean) e.putBoolean("approvalCleanup", v)
                "pollInterval" -> if (v is Int) e.putInt("pollIntervalSec", v.coerceIn(5, 60))
            }
        }
        e.commit() // 同步落盘(设置项小,且崩溃时不丢)
        return fetch(c)
    }

    /** 兼容旧调用(本地缓存即设置本体)。 */
    fun cached(c: android.content.Context): ServerSettings = fetch(c)
}
