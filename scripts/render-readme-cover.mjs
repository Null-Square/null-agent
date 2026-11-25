import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const images = fileURLToPath(new URL('../docs/images/', import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'null-agent-cover-'));
const scenes = [
  ['risks-inbox', 'Triage the findings', 'Six imported findings across four assets. Start with the missing refund approval event.', 72, 335],
  ['evidence-library', 'Trace the evidence', 'Five files in the payments assessment. Follow a control back to its original change record.', 72, 304],
  ['code-review', 'Review the change', 'A saved finding points to reader.js. The workbench pairs the source with a suggested fix.', 70, 438],
];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({viewport:{width:1280,height:640}, deviceScaleFactor:1});
  for (const [index, [file, title, detail, left, top]] of scenes.entries()) {
    const png = (await readFile(path.join(images, file + '.png'))).toString('base64');
    await page.setContent(`<!DOCTYPE html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#171715;color:#f7f6f0;font-family:Arial,sans-serif}
      header{height:130px;display:flex;align-items:center;gap:22px;margin:0 44px;border-bottom:1px solid #53534b}
      .mark{background:#ffdc32;width:46px;height:46px}h1{font-size:64px;letter-spacing:-4px;margin:0}
      header span{margin-left:auto;font:17px monospace;color:#d6d5cc}
      main{display:grid;grid-template-columns:344px 1fr;gap:32px;padding:35px 44px 0}
      article{padding-top:22px}small,footer{font:15px monospace;letter-spacing:1px}small{color:#ffdc32}
      h2{font-size:56px;line-height:.96;letter-spacing:-3px;margin:28px 0 20px}
      p{font-size:22px;line-height:1.38;color:#cccac1;margin:0;max-width:305px}
      .rail{display:flex;gap:6px;margin-top:44px}.rail i{width:44px;height:4px;background:#515149}.rail .active{background:#ffdc32}
      figure{margin:0;border:1px solid #53534b;border-radius:8px;overflow:hidden;background:#000}
      figcaption{padding:13px 20px;background:#242421;color:#e8e7dd;font:16px monospace;border-bottom:1px solid #53534b}
      .view{position:relative;height:340px;overflow:hidden}.view img{position:absolute;width:1224px;left:${-left*.85}px;top:${-top*.85}px}
      footer{display:flex;justify-content:space-between;margin:32px 44px 0;padding-top:17px;border-top:1px solid #53534b;color:#aaa99f}
      </style><header><div class="mark"></div><h1>Null Agent</h1><span>Local security workspace</span></header>
      <main><article><small>PAYMENTS SERVICE</small><h2>${title}</h2><p>${detail}</p><div class="rail">${scenes.map((_,i)=>'<i class="'+(i===index?'active':'')+'"></i>').join('')}</div></article>
      <figure><figcaption>${['Risks','Compliance / Evidence Library','Assessments / Code review'][index]}</figcaption><div class="view"><img src="data:image/png;base64,${png}"></div></figure></main>
      <footer><span>NULLSQUARE</span><span>Demo workspace Â· Synthetic evidence</span></footer>`);
    await page.locator('img').evaluate(img => img.decode());
    await page.screenshot({path:path.join(temp, index + '.png')});
  }
  execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-framerate','1/4','-i',path.join(temp,'%d.png'),
    '-filter_complex','split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer','-loop','0','-final_delay','400',path.join(images,'payments-walkthrough.gif')]);
} finally {
  await browser.close();
  await rm(temp, {recursive:true, force:true});
}
