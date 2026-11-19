// Release smoke: prepare a solved scenario through LabApi, then import the file and perform the checks in Chromium's real UI.
// No physical devices, external requests, remote browser automation, or manual state injection into the application.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Lab} from '../src/engine/lab.ts';
import {solveWithFiles} from '../tests/lab/all-scenarios-driver.ts';
const req=createRequire(import.meta.url), pp=req(process.env.PUPPETEER_CORE??'puppeteer-core');
const candidate=resolve(process.argv[2]??'dist/index.html'), tmp=await mkdtemp(join(tmpdir(),'netlab-worked-'));
const lab=new Lab({storage:null});assert(lab.startScenario('case-study-2026','free',{seed:0}).ok);assert.equal(solveWithFiles(lab).points,18);
const src=join(tmp,'worked.json');await writeFile(src,lab.exportLab());
const browser=await pp.launch({executablePath:process.env.CHROME_PATH,headless:true,args:process.env.CHROME_NO_SANDBOX==='1'?['--no-sandbox']:[]});
try{
 const page=await browser.newPage();await page.setViewport({width:1440,height:950});await page.setRequestInterception(true);
 const runtime=[],external=[];page.on('pageerror',e=>runtime.push(e.message));page.on('console',m=>{if(m.type()==='error')runtime.push(m.text())});page.on('request',r=>{if(/^https?:/i.test(r.url())){external.push(r.url());r.abort();}else r.continue()});
 const text=async sel=>page.$eval(sel,e=>e.innerText);
 const click=async (search,scope='button')=>{const h=await page.waitForFunction((sel,t)=>[...document.querySelectorAll(sel)].find(e=>e.getClientRects().length&&e.innerText.trim().includes(t)),{},scope,search);const el=h.asElement();await el.scrollIntoView();await page.waitForFunction(el=>{const r=el.getBoundingClientRect(); const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===el||el.contains(hit)}, {timeout:12000}, el).catch(async()=>{throw new Error('Control obscured: '+search+' by '+await el.evaluate(el=>{const r=el.getBoundingClientRect();return (document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML||'nothing').slice(0,120)}))});await el.click();await h.dispose()};
 await page.goto(pathToFileURL(candidate).href,{waitUntil:'load'});await page.evaluate(()=>document.fonts.ready);
 const [chooser]=await Promise.all([page.waitForFileChooser(),click('Open a lab file')]);await chooser.accept([src]);await page.waitForSelector('.wb-root[data-mode=free]');
 await click('Commands','.nl-top-actions button');await click('Device support');await page.waitForSelector('.nl-ds input[type=search]',{visible:true,timeout:9000});await page.type('.nl-ds input[type=search]','ip nat');await page.select('.nl-ds select','c9300l');await page.waitForFunction(()=>document.querySelector('.nl-ds')?.innerText.includes('Catalyst 9300L')&&document.querySelector('.nl-ds-probe'));
 assert.match(await text('.nl-ds'),/ip nat/i);await click('Commands','.nl-top-actions button');
 await click('Tools','.nl-top-actions button');let selects=await page.$$('.nl-tool select');await selects[0].select('PC1');await selects[1].select('60.50.40.2');await click('Send the packet');await page.waitForSelector('.nl-walk-result');const trace=await text('.nl-walk-result');assert.match(trace,/It works/i);assert.match(trace,/60\.50\.50\.100/);assert.match(trace,/ESP/);assert.match(trace,/way back/i);
 await click('QoS load test','[role=tab]');selects=await page.$$('.nl-tool select');await selects[0].select('R1');await selects[1].select('Serial0/1/0');await click('Run the load test');await page.waitForSelector('.nl-qos-sum');assert.match(await text('.nl-qos-result'),/121\.6 kbit\/s/);
 await click('Tools','.nl-top-actions button');await click('Check','.nl-top-actions button');await page.waitForSelector('.nl-score');const score=await text('.nl-score');assert.match(score,/18 of 18 points/);assert.match(score,/All scored requirements passed/);assert.match(score,/Course compatible/);assert.match(await text('.nl-report'),/Unscored reminders/);
 assert.deepEqual(runtime,[]); assert.deepEqual(external,[]); console.log('PASS: offline file:// bundle; imported LabApi-solved case, Catalyst device-support search, NAT/ESP ping trace and reply, 121.6 kbps QoS estimate, 18/18 modeled report + advisory and grade-time profile. No external loads or runtime errors.');console.log(createHash('sha256').update(await readFile(candidate)).digest('hex'));
}catch(e){const [p]= (await browser.pages()).slice(-1);console.error((await p.evaluate(()=>document.body.innerText)).slice(-4000));throw e;}finally{await browser.close();await rm(tmp,{recursive:true,force:true})}
