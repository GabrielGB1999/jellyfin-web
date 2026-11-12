// usage: node frames.js <html> <outdir> <fps> <duration>
const { chromium } = require('playwright');
(async () => {
  const [html, out, fps, dur] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  await p.goto('file://' + html);
  await p.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); });
  const n = Math.round(fps * dur);
  for (let f = 0; f < n; f++) {
    await p.evaluate(t => render(t), f / fps);
    await p.screenshot({ path: `${out}/f${String(f).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 93 });
  }
  await b.close();
  console.log('frames', n);
})();
