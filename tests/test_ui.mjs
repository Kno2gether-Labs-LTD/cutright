// Drive the editor UI via system Chrome (puppeteer-core) to prove the edit loop.
import puppeteer from 'puppeteer-core';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W='/Users/avijit/Pre_final_edit';
const b=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--disable-gpu','--no-sandbox','--window-size=1680,1000']});
const p=await b.newPage(); await p.setViewport({width:1680,height:1000});
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text());}); p.on('pageerror',e=>errs.push('PAGEERR '+e.message));
await p.goto('http://localhost:4599/',{waitUntil:'networkidle2',timeout:15000});
await new Promise(r=>setTimeout(r,1500));
// 1) click a scene block (the coral 'counter' one ~ proof) — pick a scene block by text
const scenes=await p.$$('#laneScenes .block');
console.log('scene blocks:',scenes.length,'caption ticks:',(await p.$$('#laneCaps .cap')).length);
// click the 5th scene block
await scenes[4].click(); await new Promise(r=>setTimeout(r,300));
await p.screenshot({path:`${W}/ui_scene.png`});
const insp1=await p.$eval('#inspector',e=>e.innerText.slice(0,200));
console.log('INSPECTOR (scene):',JSON.stringify(insp1.replace(/\n+/g,' | ')));
// 2) click a caption tick in the middle
const caps=await p.$$('#laneCaps .cap');
await caps[Math.floor(caps.length/2)].click(); await new Promise(r=>setTimeout(r,300));
await p.screenshot({path:`${W}/ui_caption.png`});
const insp2=await p.$eval('#inspector',e=>e.innerText.slice(0,160));
console.log('INSPECTOR (caption):',JSON.stringify(insp2.replace(/\n+/g,' | ')));
// terminal rendered?
const termRows=await p.$$eval('#terminal .xterm-rows > div',d=>d.length).catch(()=>0);
console.log('terminal xterm rows rendered:',termRows);
console.log('console errors:',errs.length?errs.slice(0,4):'none');
await b.close();
