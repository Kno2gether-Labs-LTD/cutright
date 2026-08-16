import puppeteer from 'puppeteer-core';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W='/Users/avijit/Pre_final_edit';
const b=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--disable-gpu','--no-sandbox','--window-size=1680,1000']});
const p=await b.newPage(); await p.setViewport({width:1680,height:1000});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERR '+e.message)); p.on('console',m=>{if(m.type()==='error'&&!/404/.test(m.text()))errs.push(m.text());});
await p.goto('http://localhost:4599/',{waitUntil:'networkidle2',timeout:15000});
await new Promise(r=>setTimeout(r,1200));
// tracks present?
const hasCuts=await p.$('#laneCuts')?true:false;
const genBtn=await p.$('[data-gen]')?true:false;
const cutBtn=await p.$('[data-add="cut"]')?true:false;
console.log('cuts track:',hasCuts,'| +cut button:',cutBtn,'| generate button:',genBtn);
// seek to 100s then add a cut
await p.evaluate(()=>{document.querySelector('#video').currentTime=100;});
await new Promise(r=>setTimeout(r,200));
await p.click('[data-add="cut"]'); await new Promise(r=>setTimeout(r,400));
const cutBlocks=await p.$$('#laneCuts .cutblock');
const insp=await p.$eval('#inspector',e=>e.innerText.slice(0,180));
console.log('cut blocks after add:',cutBlocks.length);
console.log('INSPECTOR (cut):',JSON.stringify(insp.replace(/\n+/g,' | ')));
await p.screenshot({path:`${W}/ui_cuts.png`});
// cleanup: delete the cut we added, save, verify gone
const delBtn=await p.$('#inspector .del'); if(delBtn){await delBtn.click(); await new Promise(r=>setTimeout(r,600));}
const cutsAfter=await p.$$('#laneCuts .cutblock');
console.log('cut blocks after delete (cleanup):',cutsAfter.length);
console.log('page errors:',errs.length?errs.slice(0,3):'none');
await b.close();
