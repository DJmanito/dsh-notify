package com.dsh.notify.notify

/**
 * /notify-state 单帧快照(服务端契约,见 dsh-notify 插件;
 * 问答/判定字段在响应缺失时按空处理,向后兼容)。
 */
data class NotifyFrame(
    val running: Boolean,
    val pendingApproval: Boolean,
    val runningTitle: String,
    val approvalTitle: String,
    val runningSessionIds: List<String>,
    val approvalSessionIds: List<String>,
    val questionSessionIds: List<String> = emptyList(),
    val questionTitle: String = "",
    val pendingQuestion: Boolean = false,
    // 最近审批判定 sid -> 'approved'|'denied'(✅/❌ 文案;响应缺失 → 空,兼容)
    val decisions: Map<String, String> = emptyMap(),
)

/**
 * 边沿触发通知事件(状态机输出 → 前台服务转 NotificationManager 推送)。
 */
sealed class NotifyEvent {
    /** 出现新的待审批会话(会话级去重后)。sids = 本帧新出现的审批会话 id。 */
    data class ApprovalNeeded(val sids: List<String>, val title: String) : NotifyEvent()

    /** 出现新的待回答会话(ask_user_question 未应答,会话级去重)。 */
    data class QuestionNeeded(val sids: List<String>, val title: String) : NotifyEvent()

    /** 待审批会话被解决(仅对本进程内真正发过通知的 id;基线吞入的不发,避免"没通知过却报完成")。 */
    data class ApprovalResolved(val sids: List<String>) : NotifyEvent()

    /** 待回答会话被解决(语义同 ApprovalResolved)。 */
    data class QuestionResolved(val sids: List<String>) : NotifyEvent()

    /** 运行中会话从有到无 = 会话完成。sids = 消失的会话 id 集合(同帧多会话聚合为一条)。 */
    data class SessionDone(val sids: List<String>, val title: String) : NotifyEvent()
}

/**
 * 通知状态机(纯 JVM,可单测;与 Android 框架解耦)。
 *
 * 语义:
 * - 基线首帧只建快照、不发事件(避免冷启动把既有状态当新事件重放);
 * - approvalSessionIds 出现上一帧未通知过的新 id → [NotifyEvent.ApprovalNeeded]
 *   (文案 = approvalTitle 非空 ? approvalTitle : "有会话等待审批");
 * - 同一审批 id 在列表中持续存在 → 不重复通知;消失(已处置)后再出现 → 视为新审批,重新通知;
 * - questionSessionIds(ask_user_question 未应答)边沿语义与审批相同 → [NotifyEvent.QuestionNeeded];
 * - runningSessionIds 中某 id 从有到无 → [NotifyEvent.SessionDone](running 差集);
 *   同帧多会话消失 → 聚合为一条(文案 "N 个会话已完成");
 *   文案:上一帧恰 1 个运行会话且其标题非空 → 用该标题;否则 "会话已完成";
 * - App 前台可见时的静默由调用方(C-3 前台服务)负责,本状态机不感知可见性。
 */
class NotifyStateMachine {

    private var baselineBuilt = false
    private var lastRunning: Set<String> = emptySet()
    private val notifiedApprovals = mutableSetOf<String>()
    private val notifiedQuestions = mutableSetOf<String>()
    // 本进程内真正发过"等待"通知的 id(基线吞入的不算)→ 解决时只对它们发 Resolved(撤回用)
    private val notifiedNewApprovals = mutableSetOf<String>()
    private val notifiedNewQuestions = mutableSetOf<String>()
    private var lastRunningTitle = ""

    /** 喂入一帧快照,返回本帧应发出的事件列表(可能为空)。 */
    fun update(frame: NotifyFrame): List<NotifyEvent> {
        val running = frame.runningSessionIds.toSet()
        val approval = frame.approvalSessionIds.toSet()

        if (!baselineBuilt) {
            baselineBuilt = true
            lastRunning = running
            notifiedApprovals.clear()
            notifiedApprovals += approval
            // 基线帧的既有问答同样吞入去重集(与审批同语义:冷启动不重放)
            notifiedQuestions.clear()
            notifiedQuestions += frame.questionSessionIds
            lastRunningTitle = frame.runningTitle
            return emptyList()
        }

        val events = mutableListOf<NotifyEvent>()

        // 1) 审批边沿:新 id(会话级去重)
        val newApprovals = approval - notifiedApprovals
        if (newApprovals.isNotEmpty()) {
            events += NotifyEvent.ApprovalNeeded(
                sids = newApprovals.sorted(),
                title = if (frame.approvalTitle.isNotBlank()) frame.approvalTitle else DEFAULT_APPROVAL_TITLE,
            )
            notifiedNewApprovals += newApprovals
        }

        // 1a) 审批解决边沿:本进程内通知过且现已消失 → 撤回用
        val resolvedApprovals = notifiedNewApprovals - approval
        if (resolvedApprovals.isNotEmpty()) {
            events += NotifyEvent.ApprovalResolved(sids = resolvedApprovals.sorted())
            notifiedNewApprovals -= resolvedApprovals
        }

        // 1b) 问答边沿:新 id(会话级去重;答完后 id 消失,再问会重新通知)
        val questions = frame.questionSessionIds.toSet()
        val newQuestions = questions - notifiedQuestions
        if (newQuestions.isNotEmpty()) {
            events += NotifyEvent.QuestionNeeded(
                sids = newQuestions.sorted(),
                title = if (frame.questionTitle.isNotBlank()) frame.questionTitle else DEFAULT_QUESTION_TITLE,
            )
            notifiedNewQuestions += newQuestions
        }

        // 1c) 问答解决边沿(撤回用)
        val resolvedQuestions = notifiedNewQuestions - questions
        if (resolvedQuestions.isNotEmpty()) {
            events += NotifyEvent.QuestionResolved(sids = resolvedQuestions.sorted())
            notifiedNewQuestions -= resolvedQuestions
        }

        // 2) 运行消失边沿:差集 → 会话完成
        val done = lastRunning - running
        if (done.isNotEmpty()) {
            val title = when {
                done.size > 1 -> "${done.size} 个会话已完成"
                lastRunning.size == 1 && lastRunningTitle.isNotBlank() -> lastRunningTitle
                else -> DEFAULT_DONE_TITLE
            }
            events += NotifyEvent.SessionDone(sids = done.sorted(), title = title)
        }

        // 3) 状态更新
        notifiedApprovals.retainAll(approval)
        notifiedApprovals += newApprovals
        notifiedQuestions.retainAll(questions)
        notifiedQuestions += newQuestions
        lastRunning = running
        if (running.isNotEmpty()) lastRunningTitle = frame.runningTitle
        return events
    }

    /** 冷启动/切换服务器时重置(下一帧重建基线)。 */
    fun reset() {
        baselineBuilt = false
        lastRunning = emptySet()
        notifiedApprovals.clear()
        notifiedQuestions.clear()
        notifiedNewApprovals.clear()
        notifiedNewQuestions.clear()
        lastRunningTitle = ""
    }

    // ---- 快照/恢复(进程被杀后重建,保持"基线首帧不重放"语义;纯 JVM,单测覆盖) ----
    // 格式 v2 = 5 段:baseline / lastRunning / notifiedApprovals / notifiedQuestions / lastRunningTitle
    // 兼容 v1 = 4 段(无问答,恢复时 notifiedQuestions 置空)

    private fun snapSep() = '\u0001'

    fun snapshot(): String =
        listOf(
            if (baselineBuilt) "1" else "0",
            lastRunning.joinToString(","),
            notifiedApprovals.joinToString(","),
            notifiedQuestions.joinToString(","),
            lastRunningTitle,
        ).joinToString(snapSep().toString())

    fun restore(s: String) {
        val parts = s.split(snapSep())
        when (parts.size) {
            5 -> {
                baselineBuilt = parts[0] == "1"
                lastRunning = if (parts[1].isEmpty()) emptySet() else parts[1].split(",").toSet()
                notifiedApprovals.clear()
                if (parts[2].isNotEmpty()) notifiedApprovals += parts[2].split(",")
                notifiedQuestions.clear()
                if (parts[3].isNotEmpty()) notifiedQuestions += parts[3].split(",")
                lastRunningTitle = parts[4]
            }
            4 -> { // v1 兼容
                baselineBuilt = parts[0] == "1"
                lastRunning = if (parts[1].isEmpty()) emptySet() else parts[1].split(",").toSet()
                notifiedApprovals.clear()
                if (parts[2].isNotEmpty()) notifiedApprovals += parts[2].split(",")
                notifiedQuestions.clear()
                lastRunningTitle = parts[3]
            }
            else -> return
        }
    }

    companion object {
        const val DEFAULT_APPROVAL_TITLE = "有会话等待审批"
        const val DEFAULT_QUESTION_TITLE = "有会话等待回答"
        const val DEFAULT_DONE_TITLE = "会话已完成"
    }
}
