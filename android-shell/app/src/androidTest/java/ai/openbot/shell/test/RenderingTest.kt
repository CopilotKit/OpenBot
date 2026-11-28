package ai.openbot.shell.test

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream

/**
 * Is the Bots page's ghosting (its header repeated in rectangles) the page's layout or the
 * emulator's drawing? Three looks at the same settled page: the DOM's own geometry, the WebView drawn
 * on a software canvas and with a software layer (test only, never in the app), and the same address
 * in the emulator's Chrome.
 */
@RunWith(AndroidJUnit4::class)
class RenderingTest : ShellTestBase() {
    private fun webView(): WebView? {
        var found: WebView? = null
        instrumentation.runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).firstOrNull()
            fun walk(view: View) {
                if (found != null) return
                if (view is WebView) found = view
                if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
            }
            activity?.window?.decorView?.let { walk(it) }
        }
        return found
    }

    @Test
    fun testBotsPageRendering() {
        if (!launchSignedIn()) return
        check(waitPageText("Start a conversation", 30_000), "Home did not render")
        tab(Tab.BOTS)?.click()
        check(waitPageText("Research Bot", 20_000), "Bots did not render")
        sleep(5_000)
        screenshot("1-bots-gpu")

        // 1. The DOM's own geometry.
        val dom = pageString(
            "JSON.stringify({h1: document.querySelectorAll('h1').length, h1Text: Array.prototype.map.call(document.querySelectorAll('h1'), function(e){return e.innerText;})," +
                "heading: (function(){var e=document.querySelector('h1');if(!e)return null;var r=e.getBoundingClientRect();return [r.top,r.bottom];})()," +
                "cards: Array.prototype.slice.call(document.querySelectorAll('[data-slot=item],li,article'),0,3).map(function(e){var r=e.getBoundingClientRect();return [Math.round(r.top),Math.round(r.bottom)];})," +
                "scrollHeight: document.scrollingElement.scrollHeight, innerHeight: window.innerHeight," +
                "css: (function(){var o={sticky:0,backdrop:0,cv:0,mask:0,transform:0};document.querySelectorAll('*').forEach(function(e){var c=getComputedStyle(e);" +
                "if(c.position==='sticky')o.sticky++;if(c.backdropFilter&&c.backdropFilter!=='none')o.backdrop++;if(c.contentVisibility&&c.contentVisibility!=='visible')o.cv++;" +
                "if(c.maskImage&&c.maskImage!=='none')o.mask++;if(c.transform&&c.transform!=='none')o.transform++;});return o;})()})",
        )
        note("rendering: Bots DOM $dom")

        // 2. The WebView drawn on a software canvas, then with a software layer.
        val web = webView()
        if (web != null) {
            val dir = instrumentation.targetContext.getExternalFilesDir(null)
            val file = File(dir, "bots-software-canvas.png")
            instrumentation.runOnMainSync {
                val bitmap = Bitmap.createBitmap(web.width, web.height, Bitmap.Config.ARGB_8888)
                web.draw(Canvas(bitmap))
                FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
            shell("cp ${file.absolutePath} $SHOTS/${testName}--2-bots-software-canvas.png")
            instrumentation.runOnMainSync { web.setLayerType(View.LAYER_TYPE_SOFTWARE, null) }
            sleep(2_500)
            screenshot("3-bots-software-layer")
            instrumentation.runOnMainSync { web.setLayerType(View.LAYER_TYPE_NONE, null) }
            sleep(1_500)
        }

        // 3. The same address in the emulator's Chrome (signed out there: whatever long page shows).
        shell("am start -a android.intent.action.VIEW -d http://localhost:3010/bots -p com.android.chrome")
        sleep(8_000)
        dismissChromeScreens()
        sleep(2_000)
        screenshot("4-chrome-same-address")
        note("rendering: Chrome shows ${appText("com.android.chrome").take(200).replace("\n", " | ")}")
        device.pressBack()
    }
}
