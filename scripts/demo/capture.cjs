/** Film a fresh, isolated REPLAY demo. Personal demo identities are shown as role labels. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const work = process.env.DEMO_WORK || '/private/tmp/payops-video-v2';
const base = process.env.DEMO_URL || 'http://localhost:5187';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const font = weight => fs.readFileSync(path.resolve(__dirname, `../../apps/web/node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff2`)).toString('base64');
const card = (kicker, title, body, footer = 'PAYOPS AI / PRODUCT WALKTHROUGH') => `<!doctype html><style>
@font-face{font-family:Plex;src:url(data:font/woff2;base64,${font(400)})}@font-face{font-family:Plex;src:url(data:font/woff2;base64,${font(600)});font-weight:600}
*{box-sizing:border-box}html{height:100%;background:#F5F2EA}body{height:100vh;position:relative;margin:0;background:#F5F2EA;color:#202C28;font-family:Plex,Arial,sans-serif;padding:85px 100px}small{font-size:20px;letter-spacing:3px;color:#1E5A4C}h1{font-size:67px;line-height:1.12;letter-spacing:-1.4px;margin:28px 0 35px;font-weight:600}p{font-size:29px;line-height:1.5;color:#52625A;max-width:1250px}.rows{margin-top:36px;max-width:1270px}.row{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #B8C3BB;padding:18px 8px;font-size:28px}.row b{color:#1E5A4C;font-weight:600}.row:last-child{border-bottom:1px solid #B8C3BB}.delayed{opacity:0;animation:appear .45s ease forwards;animation-delay:var(--delay)}@keyframes appear{to{opacity:1}}.foot{position:fixed;bottom:45px;left:100px;right:100px;border-top:1px solid #B8C3BB;padding-top:20px;font-size:17px;letter-spacing:2px;color:#52625A}
</style><small>${kicker}</small><h1>${title}</h1>${body}<div class="foot">${footer}</div>`;
const cards = {
 intro: card('PAYMENT SUCCESSFUL', 'One payment.<br>Three different stories.', '<p>The customer has paid. Inside the business, the records disagree.</p><div class="rows"><div class="row"><span>Payment gateway</span><b>CAPTURED</b></div><div class="row delayed" style="--delay:2s"><span>Order service</span><b>FAILED</b></div><div class="row delayed" style="--delay:4s"><span>Accounting ledger</span><b>MISSING</b></div></div>', 'A PAYMENT OPERATIONS PROBLEM'),
 reveal: card('FOLLOW THE EVIDENCE', 'Meet PayOps AI.', '<p>A workspace for investigating payment mismatches<br>and checking the result.</p><div class="rows"><div class="row"><span>Investigate</span><b>Find the cause</b></div><div class="row"><span>Inspect</span><b>Open the proof</b></div><div class="row"><span>Verify</span><b>Check what changed</b></div></div>'),
 architecture: card('ILLUSTRATIVE ARCHITECTURE', 'Select the right specialists.<br>Keep the workflow bounded.', '<div class="rows"><div class="row"><b>Payment</b><span>Gateway and order records</span></div><div class="row"><b>Reconciliation</b><span>Ledger, webhook and settlement</span></div><div class="row"><b>Risk</b><span>Account and payment signals</span></div></div><p>Selected specialists → cited findings → grounded proposal</p>'),
 engineering: card('HOW IT WORKS', 'Reasoning, authority,<br>and verification.', '<div class="rows"><div class="row"><b>LangGraph</b><span>Coordinate a durable, bounded workflow</span></div><div class="row"><b>Jev and Gemini</b><span>Typed decisions and investigation</span></div><div class="row"><b>Application code</b><span>Policy, approval, execution and validation</span></div></div>'),
 outro: card('PAYOPS AI', 'From disagreement<br>to a verified result.', '<div class="rows"><div class="row"><span>Find the cause</span><span>Open the proof</span></div><div class="row"><span>Apply a permitted fix</span><span>Verify what changed</span></div></div><p>Explore the running demo and the repository<br>to follow the complete workflow.</p>', 'SIMULATED PAYMENTS / REPLAYED MODEL RESPONSES')
};
// Recording-only presentation redaction. Business records, actions and verdicts remain intact.
function maskIdentities(pairs) {
 const replace = node => {
  if (node.nodeType !== Node.TEXT_NODE || ['SCRIPT','STYLE','TEXTAREA'].includes(node.parentElement?.tagName)) return;
  let value = node.nodeValue;
  for (const [name, label] of pairs) value = value.split(name).join(label);
  if (value !== node.nodeValue) node.nodeValue = value;
 };
 const walk = root => {
  if(root.nodeType===Node.TEXT_NODE){replace(root);return;}
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
  while((node=walker.nextNode())) replace(node);
 };
 const install=()=>{
  walk(document.body);
  new MutationObserver(records=>{for(const record of records){if(record.type==='characterData')replace(record.target);else record.addedNodes.forEach(walk);}}).observe(document.body,{childList:true,subtree:true,characterData:true});
 };
 if(document.body)install();else document.addEventListener('DOMContentLoaded',install,{once:true});
}
(async () => {
 fs.mkdirSync(path.join(work,'raw'),{recursive:true});
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 if(process.env.DEMO_CARDS_ONLY==='1'){
  const saved=JSON.parse(fs.readFileSync(path.join(work,'clips.json'),'utf8'));
  for(const [id,hold] of [['intro',20],['reveal',6],['architecture',6],['engineering',6],['outro',6]]){
   const ctx=await browser.newContext({viewport:{width:1600,height:900},recordVideo:{dir:path.join(work,'raw'),size:{width:1600,height:900}}});
   const page=await ctx.newPage();const epoch=Date.now();await page.setContent(cards[id]);await page.evaluate(()=>document.fonts.ready);await wait(500);const start=(Date.now()-epoch)/1000;await wait(hold*1000);const end=(Date.now()-epoch)/1000;await ctx.close();
   const index=saved.findIndex(c=>c.id===id);saved[index]={id,file:await page.video().path(),start,end};console.warn('Recorded card',id);
  }
  fs.writeFileSync(path.join(work,'clips.json'),JSON.stringify(saved,null,2));await browser.close();return;
 }
 const auth=await browser.newContext();
 const accounts=await (await auth.request.get(base+'/api/auth/demo-accounts')).json();
 const pairs=accounts.map(a=>[a.name,a.label]);
 const login=await auth.request.post(base+'/api/auth/login',{data:{email:'ops@payops.dev',password:'payops-demo'}});
 if(!login.ok())throw Error('Demo login failed');
 await auth.storageState({path:path.join(work,'ops.json')});
 const cases=await (await auth.request.get(base+'/api/cases?limit=100')).json();
 const payment=cases.items.find(c=>c.displayId==='PAY-0005');
 const refund=cases.items.find(c=>c.displayId==='RFD-0002');
 if(!payment||!refund||payment.status!=='OPEN'||refund.status!=='OPEN')throw Error('Use a fresh isolated seeded database');
 await auth.close();
 const clips=[]; const bodies=[];
 async function capture(id,action,hold=8,role='ops'){
  const ctx=await browser.newContext({viewport:{width:1600,height:900},storageState:path.join(work,role+'.json'),recordVideo:{dir:path.join(work,'raw'),size:{width:1600,height:900}}});
  await ctx.addInitScript(maskIdentities,pairs);
  const page=await ctx.newPage();const epoch=Date.now();let start=0;
  const begin=()=>{start=(Date.now()-epoch)/1000};
  await action(page,ctx,begin);await wait(hold*1000);
  const body=await page.locator('body').innerText();
  for(const [name] of pairs)if(body.includes(name))throw Error('A personal demo identity is still visible');
  bodies.push({id,text:body});const end=(Date.now()-epoch)/1000;
  await ctx.close();clips.push({id,file:await page.video().path(),start,end});
  fs.writeFileSync(path.join(work,'clips.json'),JSON.stringify(clips,null,2));
  fs.writeFileSync(path.join(work,'screen-text.json'),JSON.stringify(bodies,null,2));
  console.warn('Recorded',id,Math.round(end-start)+'s');
 }
 for(const [id,hold] of [['intro',20],['reveal',6],['architecture',6],['engineering',6],['outro',6]])await capture(id,async(p,c,begin)=>{await p.setContent(cards[id]);await p.evaluate(()=>document.fonts.ready);await wait(300);begin()},hold);
 await capture('overview',async(p,c,begin)=>{await p.goto(base+'/overview');await p.getByRole('heading',{name:'Overview',exact:true}).waitFor();await wait(1200);begin();},9);
 await capture('problem',async(p,c,begin)=>{await p.goto(base+'/cases/'+payment.id);await p.getByRole('button',{name:'Start investigation',exact:true}).waitFor();await wait(700);begin();},13);
 await capture('start',async(p,c,begin)=>{await p.goto(base+'/cases/'+payment.id);await p.getByRole('button',{name:'Start investigation',exact:true}).waitFor();begin();await wait(1200);await p.getByRole('button',{name:'Start investigation',exact:true}).click();let record;for(let i=0;i<120;i++){await wait(500);record=await(await c.request.get(base+'/api/cases/'+payment.id)).json();if(['RESOLVED','ESCALATED','AWAITING_APPROVAL'].includes(record.status))break;}if(record.status!=='RESOLVED')throw Error('Payment investigation did not resolve: '+record.status);await wait(900);},5);
 await capture('agents',async(p,c,begin)=>{await p.goto(base+'/cases/'+payment.id);await p.getByRole('link',{name:'Open run details',exact:true}).click();await p.getByRole('heading',{name:'Choose where to look',exact:true}).waitFor();await p.getByRole('heading',{name:'Choose where to look',exact:true}).scrollIntoViewIfNeeded();await wait(600);begin();await wait(4000);await p.getByRole('heading',{name:'Payment specialist',exact:true}).scrollIntoViewIfNeeded();await wait(4500);await p.getByRole('heading',{name:'Risk specialist',exact:true}).scrollIntoViewIfNeeded();},6);
 await capture('proof',async(p,c,begin)=>{await p.goto(base+'/cases/'+payment.id);const finding=p.getByText('Webhook delivery for payment.captured failed after 3 attempts with HTTP status 500.',{exact:true});await finding.waitFor();await finding.scrollIntoViewIfNeeded();await wait(700);begin();await wait(3500);const row=p.locator('li').filter({has:p.getByRole('heading',{name:'Checked payment and gateway records',exact:true})});await row.getByRole('button',{name:'[ev_04]',exact:true}).click();await p.getByRole('dialog').waitFor();},15);
 await capture('resolution',async(p,c,begin)=>{await p.goto(base+'/cases/'+payment.id);await p.getByRole('heading',{name:'Applied the action',exact:true}).waitFor();await p.getByRole('heading',{name:'Applied the action',exact:true}).scrollIntoViewIfNeeded();await wait(600);begin();await wait(8500);await p.getByRole('heading',{name:'Re-read the records and verified',exact:true}).scrollIntoViewIfNeeded();await wait(8500);await p.evaluate(()=>window.scrollTo({top:0,behavior:'smooth'}));},6);
 // Record the approval boundary on a second case, retaining the real role checks.
 const refundCtx=await browser.newContext({storageState:path.join(work,'ops.json')});
 const startRefund=await refundCtx.request.post(base+'/api/cases/'+refund.id+'/runs',{data:{}});if(!startRefund.ok())throw Error('Could not start refund');
 let record;for(let i=0;i<120;i++){await wait(500);record=await(await refundCtx.request.get(base+'/api/cases/'+refund.id)).json();if(record.resolutionView?.pendingApprovalId)break;}
 const approval=record.resolutionView?.pendingApprovalId;if(!approval)throw Error('Refund did not pause for approval');await refundCtx.close();
 const manager=await browser.newContext();const signed=await manager.request.post(base+'/api/auth/login',{data:{email:'manager@payops.dev',password:'payops-demo'}});if(!signed.ok())throw Error('Manager login failed');await manager.storageState({path:path.join(work,'manager.json')});await manager.close();
 await capture('approval',async(p,c,begin)=>{await p.goto(base+'/approvals?approval='+approval);await p.getByRole('radio',{name:'Approve',exact:true}).waitFor();await wait(600);begin();await wait(6000);await p.getByRole('radio',{name:'Approve',exact:true}).check();await wait(2000);await p.getByRole('button',{name:'Approve decision',exact:true}).click();for(let i=0;i<60;i++){await wait(500);record=await(await c.request.get(base+'/api/cases/'+refund.id)).json();if(record.status==='RESOLVED')break;}if(record.status!=='RESOLVED')throw Error('Approved refund did not resolve');await p.goto(base+'/cases/'+refund.id);await p.getByRole('heading',{name:'Compare payment records',exact:true}).waitFor();},7,'manager');
 await capture('audit',async(p,c,begin)=>{await p.goto(base+'/audit?caseId='+refund.id);await p.getByRole('heading',{name:'Audit log',exact:true}).waitFor();await wait(1300);begin();await wait(4000);await p.mouse.wheel(0,220);},9);
 fs.writeFileSync(path.join(work,'outcomes.json'),JSON.stringify({paymentCase:payment.displayId,paymentStatus:'RESOLVED',refundCase:refund.displayId,refundStatus:record.status,mode:'REPLAY',identityLabels:'roles'},null,2));
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
