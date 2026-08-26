package com.dsh.notify.ui

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.AttributeSet
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView

/**
 * 手机悬浮球:平时贴边半圆小球;点一下 → 完整显示(内移成全圆 🔧)+ 直接打开设置页;
 * 可拖动,松手吸附最近侧边。无展开面板/铃铛(总开关在设置页)。
 */
class FloatingBallView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : FrameLayout(context, attrs, defStyleAttr) {

    companion object {
        const val SIZE_DP = 56
    }

    var onOpenSettings: (() -> Unit)? = null

    private val dpSize = dp(SIZE_DP)
    private var dragging = false
    private var dragMoved = false
    private var downRawX = 0f
    private var downRawY = 0f
    private var startTx = 0f
    private var startTy = 0f
    private val touchSlop = dp(10)

    private val ball: TextView = TextView(context).apply {
        text = "🔧"
        textSize = 20f
        gravity = Gravity.CENTER
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor("#CC1F2430"))
        }
    }

    init {
        addView(ball, LayoutParams(dpSize, dpSize))
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(
            MeasureSpec.makeMeasureSpec(dpSize, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(dpSize, MeasureSpec.EXACTLY)
        )
    }

    /** 吸附右缘半圆(默认状态) */
    fun snapToRight(parent: ViewGroup) {
        translationX = parent.width - dpSize / 2f
        translationY = translationY.coerceIn(0f, (parent.height - dpSize).toFloat())
    }

    /** 吸附左缘半圆 */
    fun snapToLeft(parent: ViewGroup) {
        translationX = -dpSize / 2f
        translationY = translationY.coerceIn(0f, (parent.height - dpSize).toFloat())
    }

    /** 完整显示(内移全圆),随后打开设置页 */
    private fun expandAndOpen(parent: ViewGroup) {
        val targetX = if (translationX >= 0) parent.width - dpSize - dp(6).toFloat() else dp(6).toFloat()
        animate().x(targetX).setDuration(150).start()
        postDelayed({ onOpenSettings?.invoke() }, 150)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                downRawX = event.rawX; downRawY = event.rawY
                startTx = translationX; startTy = translationY
                dragging = true; dragMoved = false
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging) return false
                val dx = event.rawX - downRawX
                val dy = event.rawY - downRawY
                if (!dragMoved && Math.hypot(dx.toDouble(), dy.toDouble()) > touchSlop) dragMoved = true
                if (dragMoved) {
                    translationX = startTx + dx
                    translationY = startTy + dy
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                if (!dragging) return false
                dragging = false
                val parent = parent as? ViewGroup ?: return true
                if (dragMoved) {
                    if (translationX + dpSize / 2f < parent.width / 2) snapToLeft(parent)
                    else snapToRight(parent)
                } else {
                    expandAndOpen(parent)
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                dragging = false
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
