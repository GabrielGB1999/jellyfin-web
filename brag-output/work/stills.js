// usage: node stills.js <html> <outdir> <dsf> t1 t2 ...
const { chromium } = require('playwright');
(async () => {
  const [html, out, dsf, ...ts] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: +dsf });
  await p.goto('file://' + html);
  await p.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); });
  for (const t of ts) { await p.evaluate(t => render(+t), t); await p.screenshot({ path: `${out}/s_${t}.png` }); }
  await b.close();
})();
