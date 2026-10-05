# OpenBot desktop icons

These assets export the existing static `.orb`, `.orb::before`, and `.orb::after`
artwork in [the desktop stylesheet](../../src/styles.css). The Welcome screen
uses that same artwork. No palette, gradient, highlight, or rim is redrawn.

The source stylesheet SHA-256 for this export is
`d20db4a7bdc371fbb7a3f0780f42080dc08374811c75d2fe893f49fb962bbb1d`.

`icon.png` is the transparent 1024×1024 master. The source stays 30 CSS pixels
across, centered in a 32×32 transparent viewport with device scale 32. This
preserves the fixed-pixel rim and shadow proportions, with a 1 CSS pixel clear
margin on every side. The screenshot uses sRGB, includes both pseudo-elements,
and loads no application or network content.

## Reproduce the source export

Tool versions used: Node 24.16.0, Playwright 1.62.1, Chromium 151.0.7922.34,
Bun 1.3.14, and the desktop lockfile's Tauri CLI 2.11.4. Use an installed
Playwright 1.62.1 module and its matching Chromium executable. The renderer
records the executable hash and refuses a different browser version.

Save the following as `export-orb.cjs` outside the checkout. It takes the source
checkout, a new output directory, the Playwright module directory, and the
Chromium executable path as explicit arguments:

```javascript
// Usage: node export-orb.cjs SOURCE_ROOT FRESH_OUTPUT PLAYWRIGHT_DIR CHROMIUM
// The output must not already exist. No source or application process is modified.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function main() {
  const [sourceArg, outputArg, playwrightArg, executableArg] = process.argv.slice(2);
  if (!sourceArg || !outputArg || !playwrightArg || !executableArg) {
    throw new Error('Expected SOURCE_ROOT FRESH_OUTPUT PLAYWRIGHT_DIR CHROMIUM');
  }
  const source = fs.realpathSync(sourceArg);
  const output = path.resolve(outputArg);
  const executablePath = fs.realpathSync(executableArg);
  const playwrightDir = fs.realpathSync(playwrightArg);
  const version = require(path.join(playwrightDir, 'package.json')).version;
  if (version !== '1.62.1') throw new Error(`Expected Playwright 1.62.1, got ${version}`);
  const cssPath = path.join(source, 'desktop/src/styles.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  const selectors = ['.orb', '.orb::before', '.orb::after'];
  const rules = selectors.map(selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...css.matchAll(new RegExp(`^${escaped} \\{[^}]*\\}`, 'gm'))];
    if (matches.length !== 1) throw new Error(`Expected exactly one ${selector} rule`);
    return matches[0][0];
  }).join('\n\n');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'orb-source.css'), rules + '\n');
  const { chromium } = require(playwrightDir);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--force-color-profile=srgb'] });
  try {
    if (browser.version() !== '151.0.7922.34') throw new Error(`Unexpected Chromium ${browser.version()}`);
    const page = await browser.newPage({ viewport: { width: 32, height: 32 }, deviceScaleFactor: 32, colorScheme: 'light' });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<style>${rules}\nhtml, body { margin: 0; width: 32px; height: 32px; background: transparent; } body { display: grid; place-items: center; }</style><div class="orb"></div>`);
    const geometry = await page.locator('.orb').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: devicePixelRatio };
    });
    if (JSON.stringify(geometry) !== JSON.stringify({ x: 1, y: 1, width: 30, height: 30, dpr: 32 })) {
      throw new Error(`Unexpected source geometry: ${JSON.stringify(geometry)}`);
    }
    await page.screenshot({ path: path.join(output, 'icon.png'), omitBackground: true, animations: 'disabled', scale: 'device' });
    const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(path.join(output, 'render.json'), JSON.stringify({
      source, cssPath, cssSha256: sha256(cssPath), sourceRulesSha256: sha256(path.join(output, 'orb-source.css')),
      playwright: version, chromium: browser.version(), executablePath, executableSha256: sha256(executablePath),
      colorProfile: 'sRGB', transparentBackground: true, network: 'all routes aborted', geometry,
      outputSize: [1024, 1024], iconSha256: sha256(path.join(output, 'icon.png')),
    }, null, 2) + '\n');
    console.log(fs.readFileSync(path.join(output, 'render.json'), 'utf8'));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
```

Run from the checkout root, substituting the installed tooling paths:

```sh
node /path/to/export-orb.cjs "$PWD" /tmp/openbot-orb-export \
  /path/to/playwright /path/to/chromium
cd desktop
bun run tauri icon /tmp/openbot-orb-export/icon.png \
  --output /tmp/openbot-orb-generated
cp /tmp/openbot-orb-export/icon.png src-tauri/icons/icon.png
for asset in 32x32.png 64x64.png 128x128.png 128x128@2x.png icon.ico icon.icns; do
  cp "/tmp/openbot-orb-generated/$asset" "src-tauri/icons/$asset"
done
```

Use fresh scratch directories for each run. Keep the direct export as the
master: the CLI also emits a lower-resolution `icon.png`. Copy only the six
listed derivatives; its Store, Square, Android, and iOS outputs are unused here.
The locked CLI's default icon export provides the resampling for every derivative,
including the 64×64 RGBA image embedded by `tray::icon()` on all platforms.

For fidelity checks, rerun the renderer and icon command in new directories and
compare decoded RGBA pixels of the master and PNG derivatives. ICO includes 16,
24, 32, 48, 64, and 256 pixel PNG frames. Decode ICNS using
`iconutil --convert iconset --output /tmp/openbot-orb.iconset src-tauri/icons/icon.icns`
on macOS. ICNS chunk ordering varies across CLI runs; compare the typed chunk
payloads and decoded frame pixels instead of requiring an identical whole-file
hash. The export and replay used for these assets had equal decoded pixels.

The Rust library tests exercise the production embedded image: dimensions and
RGBA length, transparent corners, visible interior, and varied colors. The
original opaque placeholder fails the transparency and color-variation tests.
Pixel checks establish source fidelity; actual native tray rendering requires a
separate OS desktop check.

## Generated asset hashes

These SHA-256 hashes identify this export, including its specific ICNS chunk order.

| File | SHA-256 |
| --- | --- |
| `icon.png` | `455392ca6a53eddaf8b08b990eb404be53de3e9154a1bdc5d4bf9daa38b5ae1d` |
| `32x32.png` | `b3b2d402cb3cf50b7140746688675da308f3e06ff321888a987efd64dc9339ba` |
| `64x64.png` | `b5ced22dcc63d0b8881dba384a715ac3e74f52d18c46a40d923f112b5e335573` |
| `128x128.png` | `ffc8fe777c84074355d08410c39bdebe29d16a7e59aabb3902154bb421d9449a` |
| `128x128@2x.png` | `046319324c303eef04542bdb2efe3b1e75563618ad104db24f9b2552c4dc522d` |
| `icon.ico` | `44dab03a0b7a92f5f87b7f33e5823f4d6f8b5687efb115686290dded58e27a55` |
| `icon.icns` | `45926bd67fc5deab949d7d21148da3c3a81cc15890cc111619b447b04c606c48` |
