package com.dsh.notify.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.dsh.notify.MainActivity

/**
 * 通知发送:每类一渠道(待审批 / 待回答 / 会话完成)。
 * 等待类通知用确定性 id(sid 哈希区间)→ 解决时可 cancel 撤回;"静默"= 同 id 更新(仅首次弹+响)。
 * 完成类通知用自增 id(临时,自动清除)。
 */
object NotificationHelper {

    const val CHANNEL_DONE = "dsh_session_done"
    const val CHANNEL_APPROVAL = "dsh_approval"
    const val CHANNEL_QUESTION = "dsh_question"

    /** 等待类 id 区间(可按 sid 撤回):审批 1000-1999 / 问答 2000-2999;完成类 5000+ 自增 */
    private const val ID_APPROVAL_BASE = 1000
    private const val ID_QUESTION_BASE = 2000
    private var seq = 5000

    fun ensureChannels(c: Context) {
        val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_DONE, "会话完成", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "DSH 会话运行结束时提醒" })
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVAL, "待审批", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "DSH 会话等待审批时提醒" })
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_QUESTION, "待回答", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "DSH 会话向用户提问等待回答时提醒" })
    }

    /** 发送一条通知;返回实际使用的 notifId(等待类传 -1 表示自动确定性 id)。 */
    fun post(c: Context, title: String, text: String, channelId: String, baseId: Int = -1): Int {
        ensureChannels(c)
        val id = if (baseId >= 0) baseId else ++seq
        val intent = Intent(c, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            c, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(c, channelId)
            .setSmallIcon(com.dsh.notify.R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setOngoing(false)
            .setContentIntent(pi)
            .build()
        LogBus.ok("NOTIFY post id=$id channel=$channelId title=$title")
        (c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(id, n)
        return id
    }

    fun cancel(c: Context, id: Int) {
        LogBus.ok("NOTIFY cancel id=$id")
        (c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(id)
    }

    /** sid → 确定性等待类通知 id(哈希落到区间内,可反推撤回) */
    fun stableId(sid: String, base: Int): Int = base + (Math.abs(sid.hashCode()) % 1000)

    fun approvalId(sid: String) = stableId(sid, ID_APPROVAL_BASE)
    fun questionId(sid: String) = stableId(sid, ID_QUESTION_BASE)
    fun doneId(sid: String) = stableId(sid, ID_DONE_BASE)

    private const val ID_DONE_BASE = 3000
}
