package ai.openbot.shell

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator

/**
 * The native loading skeleton over the WebView's area while a page has not rendered yet: neutral
 * shapes that vaguely read as the app (a title, a subtitle, four rows of a circle and two lines, a
 * large rounded card where the message box sits) in surface-variant tones, with a soft highlight
 * sweeping left to right (1.3 s, linear, repeating). With animations off (developer options,
 * "Remove animations") the shapes stay still.
 */
class LoadingSkeletonView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val density = resources.displayMetrics.density
    private val shapes = Path()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val matrix = Matrix()
    private var shader: LinearGradient? = null
    private var base = 0
    private var highlight = 0
    private var background = 0
    private var progress = -1f
    private var animator: ValueAnimator? = null

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        // Touches stop here while it shows: nothing taps the half-loaded page underneath.
        isClickable = true
        setColors(dark = false, pageBackground = null)
    }

    /** Light or dark tones; the page's own background behind the shapes when known. */
    fun setColors(dark: Boolean, pageBackground: Int?) {
        val newBase = if (dark) 0xFF2A2A2E.toInt() else 0xFFE9E9EC.toInt()
        val newHighlight = if (dark) 0xFF3B3B40.toInt() else 0xFFF7F7F8.toInt()
        val newBackground = pageBackground ?: if (dark) 0xFF0A0A0A.toInt() else 0xFFFFFFFF.toInt()
        if (newBase == base && newHighlight == highlight && newBackground == background) return
        base = newBase
        highlight = newHighlight
        background = newBackground
        shader = null
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        buildShapes(w.toFloat(), h.toFloat())
        shader = null
    }

    private fun roundRect(x: Float, y: Float, width: Float, height: Float, radius: Float) {
        shapes.addRoundRect(RectF(x, y, x + width, y + height), radius, radius, Path.Direction.CW)
    }

    private fun buildShapes(w: Float, h: Float) {
        shapes.reset()
        val d = density
        val pad = 20 * d
        var y = 28 * d
        roundRect(pad, y, w * 0.42f, 22 * d, 7 * d)
        y += 22 * d + 12 * d
        roundRect(pad, y, w * 0.62f, 14 * d, 6 * d)
        y += 14 * d + 36 * d
        val card = 112 * d
        val cardTop = h - card - 16 * d
        val lineWidth = w - pad * 2 - 56 * d
        for (row in 0 until 4) {
            if (y + 40 * d > cardTop - 16 * d) break
            shapes.addCircle(pad + 20 * d, y + 20 * d, 20 * d, Path.Direction.CW)
            roundRect(pad + 56 * d, y + 5 * d, lineWidth * (if (row % 2 == 0) 0.78f else 0.66f), 13 * d, 6 * d)
            roundRect(pad + 56 * d, y + 25 * d, lineWidth * (if (row % 2 == 0) 0.48f else 0.56f), 11 * d, 5 * d)
            y += 40 * d + 26 * d
        }
        if (cardTop > y) roundRect(16 * d, cardTop, w - 32 * d, card, 24 * d)
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(background)
        val w = width.toFloat()
        val band = w * 0.55f
        val gradient = shader ?: LinearGradient(0f, 0f, band, 0f, intArrayOf(base, highlight, base),
            floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP).also { shader = it }
        // progress < 0: the static skeleton (the band parked off screen, so all shapes read as base).
        val start = if (progress < 0f) -band * 2 else -band + (w + band) * progress
        matrix.setTranslate(start, 0f)
        gradient.setLocalMatrix(matrix)
        paint.shader = gradient
        canvas.drawPath(shapes, paint)
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (isShown) start() else stop()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (isShown) start()
    }

    override fun onDetachedFromWindow() {
        stop()
        super.onDetachedFromWindow()
    }

    private fun start() {
        if (animator != null) return
        if (!ValueAnimator.areAnimatorsEnabled()) {
            progress = -1f
            invalidate()
            return
        }
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1_300
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener {
                progress = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    private fun stop() {
        animator?.cancel()
        animator = null
    }
}
