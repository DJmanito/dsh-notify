package com.dsh.notify

import android.content.Context

/**
 * 连接设置持久化(SharedPreferences)。
 * 目标 = 局域网 DSH web 入口(默认端口 3080,以实际环境为准),明文 HTTP 仅限可信内网。
 */
object Settings {

    private const val FILE = "dsh_remote_prefs"
    // dsh web 默认入口端口 3080;环境不同时在设置页改一次保存
    private const val DEFAULT_PORT = 3080

    private fun prefs(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun host(c: Context): String = prefs(c).getString("host", "") ?: ""

    fun port(c: Context): Int = prefs(c).getInt("port", DEFAULT_PORT)

    fun notifyEnabled(c: Context): Boolean = prefs(c).getBoolean("notifyEnabled", false)

    /** 轮询周期(秒),允许 5-60,默认 20。与 SettingsSync 共享同一 key。 */
    fun pollIntervalSec(c: Context): Int = prefs(c).getInt("pollIntervalSec", 20).coerceIn(5, 60)

    fun setHost(c: Context, h: String) = prefs(c).edit().putString("host", h.trim()).apply()

    fun setPort(c: Context, p: Int) = prefs(c).edit().putInt("port", p).apply()

    // commit() 同步落盘:开关状态在进程被杀前必须持久化(apply 异步,崩溃时会丢)
    fun setNotifyEnabled(c: Context, b: Boolean) = prefs(c).edit().putBoolean("notifyEnabled", b).commit()

    fun setPollIntervalSec(c: Context, s: Int) = prefs(c).edit().putInt("pollIntervalSec", s.coerceIn(5, 60)).apply()

    fun baseUrl(c: Context): String = "http://${host(c)}:${port(c)}/"

    fun hasServer(c: Context): Boolean = validateHost(host(c)) && validatePort(port(c))

    /** IPv4 / IPv6 / 域名(hostnames)。不做 DNS 解析,格式校验。 */
    fun validateHost(h: String): Boolean {
        val s = h.trim()
        if (s.isEmpty()) return false
        // IPv4
        if (Regex("""^\d{1,3}(\.\d{1,3}){3}$""").matches(s)) {
            return s.split('.').all { it.toIntOrNull() in 0..255 }
        }
        // IPv6(简单形态:含冒号,无空白;最短 "::" = 2 字符)
        if (s.contains(':')) return s.length in 2..64 && s.all { it.isLetterOrDigit() || it == ':' || it == '-' }
        // 域名
        return Regex("""^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$""").matches(s)
    }

    fun validatePort(p: Int): Boolean = p in 1..65535

    // ---- 通知监控心跳(C-3 前台服务与工作器互斥用) ----

    fun lastPollAt(c: Context): Long = prefs(c).getLong("lastPollAt", 0L)

    fun touchPoll(c: Context) = prefs(c).edit().putLong("lastPollAt", System.currentTimeMillis()).apply()
}
