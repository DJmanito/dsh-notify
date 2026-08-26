package com.dsh.notify.notify

import android.content.Context
import com.dsh.notify.SettingsSync

/**
 * 事件→通知处理(服务与 WorkManager 兜底共用;进程内单例)。
 * 三态语义(与 PC 端一致):
 * - always = 每次都发**新 id** 通知(每次都弹横幅+响);
 * - silent = **同 sid 固定 id**(首次弹+响,之后同 id 更新不再弹不响);
 * - off = 不发。
 * 图标:⏳ 等待 / ✅ 通过·完成 / ❌ 不通过(decisions 来自 /notify-state,approval/decided.outcome)。
 * 撤回:approvalCleanup=true 时,解决时 cancel 该 sid 的等待通知。
 * postedWaitIds 进程内共享:服务被杀后丢失 = 跨进程撤回放弃(可接受,通知随系统清理)。
 */
object EventPoster {

    private val postedWaitIds = mutableMapOf<String, Int>() // "a$sid"/"q$sid" -> notifId

    fun post(c: Context, st: SettingsSync.ServerSettings, events: List<NotifyEvent>, decisions: Map<String, String> = emptyMap()) {
        for (e in events) {
            when (e) {
                is NotifyEvent.ApprovalNeeded -> {
                    if (!st.master || st.approval == "off") continue
                    val text = if (e.sids.size > 1) "${e.title}(${e.sids.size} 个会话)" else e.title
                    e.sids.forEach { sid ->
                        // silent = 固定 id(同 id 更新,仅首次弹+响);always = 新 id(每次弹+响)
                        val id = if (st.approval == "silent") NotificationHelper.approvalId(sid) else -1
                        postedWaitIds["a$sid"] = NotificationHelper.post(c, "⏳ DSH 会话等待审批", text, NotificationHelper.CHANNEL_APPROVAL, id)
                    }
                }
                is NotifyEvent.QuestionNeeded -> {
                    if (!st.master || st.approval == "off") continue
                    val text = if (e.sids.size > 1) "${e.title}(${e.sids.size} 个会话)" else e.title
                    e.sids.forEach { sid ->
                        val id = if (st.approval == "silent") NotificationHelper.questionId(sid) else -1
                        postedWaitIds["q$sid"] = NotificationHelper.post(c, "⏳ DSH 会话等待回答", text, NotificationHelper.CHANNEL_QUESTION, id)
                    }
                }
                is NotifyEvent.ApprovalResolved -> {
                    e.sids.forEach { sid ->
                        val id = postedWaitIds.remove("a$sid")
                        if (st.approvalCleanup && id != null) NotificationHelper.cancel(c, id)
                        if (st.master && st.approvalDone == "always") {
                            val denied = decisions[sid] == "denied"
                            NotificationHelper.post(
                                c,
                                if (denied) "❌ 审批未通过" else "✅ 审批已通过",
                                if (denied) "审批被拒绝" else "审批已允许",
                                NotificationHelper.CHANNEL_APPROVAL
                            )
                        }
                    }
                }
                is NotifyEvent.QuestionResolved -> {
                    e.sids.forEach { sid ->
                        val id = postedWaitIds.remove("q$sid")
                        if (st.approvalCleanup && id != null) NotificationHelper.cancel(c, id)
                        if (st.master && st.approvalDone == "always") {
                            NotificationHelper.post(c, "✅ 已收到回答", "回答已回传", NotificationHelper.CHANNEL_QUESTION)
                        }
                    }
                }
                is NotifyEvent.SessionDone -> {
                    if (!st.master || st.taskDone == "off") continue
                    e.sids.forEach { sid ->
                        val id = if (st.taskDone == "silent") NotificationHelper.doneId(sid) else -1
                        NotificationHelper.post(c, "✅ DSH 会话已完成", e.title, NotificationHelper.CHANNEL_DONE, id)
                    }
                }
            }
        }
    }
}
