package com.dsh.notify.notify

import android.content.Context
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * 监控日志环形缓冲(设置页日志入口可见):
 * - 全进程共享(服务/工作器/Activity 同进程);
 * - 轻量持久化:每行写入即 apply,进程被杀后重启可恢复历史 →
 *   能区分"服务被杀(最后一条是 SYS PROCESS START 前的历史)"与"轮询失败/通知被压制";
 * - 上限 200 行,先进先出。
 */
object LogBus {
    private const val FILE = "dsh_notify_log"
    private const val MAX = 200
    private val lock = Any()
    private val buf = ArrayDeque<String>()
    private var ctx: Context? = null
    private var inited = false
    private val fmt: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss.SSS")

    fun init(c: Context) {
        synchronized(lock) {
            if (inited) return
            inited = true
            ctx = c.applicationContext
            val s = c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString("log", null)
            if (!s.isNullOrEmpty()) {
                for (l in s.split('\u0001')) if (l.isNotEmpty()) buf.addLast(l)
                while (buf.size > MAX) buf.removeFirst()
            }
            rawAdd("SYS", "PROCESS START(恢复历史 ${buf.size} 行)")
        }
    }

    fun ok(msg: String) = add("OK ", msg)

    fun error(msg: String) = add("ERR", msg)

    fun add(tag: String, msg: String) {
        synchronized(lock) { rawAdd(tag, msg) }
    }

    private fun rawAdd(tag: String, msg: String) {
        val line = LocalTime.now().format(fmt) + " [$tag] $msg"
        buf.addLast(line)
        while (buf.size > MAX) buf.removeFirst()
        persist()
    }

    fun snapshot(): List<String> = synchronized(lock) { buf.toList() }

    fun clear() {
        synchronized(lock) {
            buf.clear()
            persist()
            rawAdd("SYS", "日志已清空")
        }
    }

    private fun persist() {
        ctx?.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            ?.edit()?.putString("log", buf.joinToString("\u0001"))?.apply()
    }
}
