import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

function assTime(seconds) {
  const centis = Math.round(seconds * 100);
  return `0:${String(Math.floor(centis / 6000)).padStart(2,'0')}:${String(Math.floor(centis / 100) % 60).padStart(2,'0')}.${String(centis % 100).padStart(2,'0')}`;
}

// Invoked from the browser walkthrough after fixture setup. Only the model transport is simulated.
export async function recordAssessment(page, images, expectedReview) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'null-agent-film-'));
  const viewport = page.viewportSize();
  const size = {width:1088, height:700};
  const button = name => page.getByRole('button', {name,exact:true});
  const link = name => page.getByRole('link', {name,exact:true});
  const titles = [];
  let recording = false;
  let start;
  let pointer = {x:900,y:600};
  const title = text => titles.push({text,time:(performance.now()-start)/1000});
  async function click(locator) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    for (let i = 1; i <= 16; i++) {
      const t = (1 - Math.cos(Math.PI * i / 16)) / 2;
      await page.mouse.move(pointer.x + (x-pointer.x)*t, pointer.y + (y-pointer.y)*t);
      await pause(18);
    }
    pointer = {x,y};
    await pause(180);
    await locator.click();
    await pause(700);
  }
  try {
    await page.setViewportSize(size);
    await button('Dashboard').click();
    await page.mouse.move(pointer.x,pointer.y);
    const risks = page.getByRole('heading',{name:'Top risks',exact:true});
    await risks.evaluate(el => el.scrollIntoView({block:'start'}));
    await page.mouse.wheel(0,-24);
    await page.evaluate(() => {
      const cursor = document.createElement('div');
      cursor.id = 'readme-pointer';
      cursor.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1px 2px #000);';
      cursor.innerHTML = '<svg width="20" height="27" viewBox="0 0 20 27"><path d="M2 2v20l5-5 4 8 4-2-4-8h7z" fill="#ffdb37" stroke="#302c20" stroke-width="1.5"/></svg>';
      document.body.append(cursor);
      document.addEventListener('pointermove', e => {cursor.style.transform = 'translate('+e.clientX+'px,'+e.clientY+'px)';}, {signal:(window.readmeCursorEvents = new AbortController()).signal});
    });
    await page.mouse.move(pointer.x,pointer.y);
    await page.screencast.start({path:path.join(temp,'capture.webm'),size,quality:95});
    recording = true;
    start = performance.now();
    title('Open a finding from the payments dashboard');
    await pause(1700);
    await click(page.getByRole('link',{name:/file-handle-cleanup/}));
    await click(page.getByRole('tab',{name:'Evidence',exact:true}));
    await link('Download review-results.json').waitFor();
    title('Inspect the analyzer record behind the finding');
    await click(page.getByText('Preview original file',{exact:true}));
    const original = page.locator('pre').filter({hasText:'src/reader.js'});
    await original.evaluate(el => el.scrollIntoView({block:'center',behavior:'smooth'}));
    await pause(2200);
    title('Open the assessment that owns this evidence');
    await click(button('Assessments'));
    await click(page.getByRole('button',{name:/Open assessment: Payments service/i}));
    await pause(600);
    await click(link('Open workbench'));
    const run = button('Run review');
    await run.scrollIntoViewIfNeeded();
    assert.ok(await page.getByLabel('reader.js',{exact:true}).isChecked());
    assert.ok(await page.getByLabel('review-results.json',{exact:true}).isChecked());
    title('Review the source and analyzer output together   /   Simulated model');
    await pause(1800);
    await click(run);
    const response = page.getByText(expectedReview,{exact:true});
    await response.waitFor();
    await response.evaluate(el => el.scrollIntoView({block:'center',behavior:'smooth'}));
    await pause(2600);
    title('Reopen the saved review and its evidence references');
    await click(button('Open History phase'));
    await click(page.locator('summary').filter({hasText:'code-review'}).first());
    await response.waitFor();
    await pause(1600);
    title('Export the assessment with its findings and latest review');
    await click(link('Back to assessment'));
    await click(button('View report'));
    const download = page.waitForEvent('download');
    await click(link('Download Markdown report'));
    const report = await readFile(await (await download).path(),'utf8');
    assert.ok(report.includes('reader.js') && report.includes(expectedReview));
    await pause(1500);
    const end = (performance.now()-start)/1000;
    await page.screencast.stop();
    recording = false;
    const captions = `[Script Info]
ScriptType: v4.00+
PlayResX: 1088
PlayResY: 756
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Caption,Arial,22,&H00F2F2F2,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,160,12,16,1
Style: Brand,Arial,18,&H0037DBFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,0,0,1,20,12,18,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,0:00:00.00,${assTime(end+1)},Brand,,0,0,0,,NULL AGENT
` + titles.map(({text,time},i) => `Dialogue: 0,${assTime(time)},${assTime(titles[i+1]?.time ?? end+1)},Caption,,0,0,0,,${text}`).join('\n');
    await writeFile(path.join(temp,'captions.ass'),captions);
    const encode = args => execFileSync('ffmpeg',['-loglevel','error','-y',...args],{cwd:temp});
    const mp4 = path.join(images,'payments-review.mp4');
    encode(['-i','capture.webm','-vf','pad=1088:756:0:0:color=0x191919,ass=captions.ass','-c:v','libx264','-crf','16','-pix_fmt','yuv420p','-movflags','+faststart',mp4]);
    encode(['-i',mp4,'-filter_complex','fps=12,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer','-loop','0',path.join(images,'payments-walkthrough.gif')]);
  } finally {
    if (recording) await page.screencast.stop();
    await page.evaluate(() => {document.querySelector('#readme-pointer')?.remove();window.readmeCursorEvents?.abort();delete window.readmeCursorEvents;});
    await page.setViewportSize(viewport);
    await rm(temp,{recursive:true,force:true});
  }
}
