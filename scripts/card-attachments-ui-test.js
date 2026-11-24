import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { startKit, until } from './browser-kit.js';

const kit = await startKit('files435');
try {
  const project = '預設專案', slug = 'main', name = '林志明', language = 'en';
  const { body: user } = await kit.call(null, '/api/join', 'POST', { name, role:'PO' });
  const { js, cdp, login } = await kit.browser(1280,900);
  async function saveShot(stem) {
    const dest = process.env.CARD_ATTACHMENT_SHOTS;
    if (!dest) return;
    mkdirSync(dest, {recursive:true});
    const shot = await cdp('Page.captureScreenshot', {format:'png'});
    writeFileSync(path.join(dest, stem + '.png'), Buffer.from(shot.result.data, 'base64'));
  }
  await login(user.token);
  await js(`localStorage.setItem('aigile-lang', ${JSON.stringify(language)}); true`);
  for (const type of ['工作','人類紀錄']) {
    const { body: card, status } = await kit.call(user.token,'/api/cards','POST',{project,type,title:type === '工作' ? 'Review attachments' : 'Meeting notes',requestId:'fixture-'+type});
    assert.equal(status,201,JSON.stringify(card));
    for (const width of [1280,375]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:width===375?812:900,deviceScaleFactor:1,mobile:width===375});
      await login(user.token, '/p/'+slug+'/work');
      const target = JSON.stringify('[data-card="'+card.cardId+'"]');
      await until(()=>js(`!!document.querySelector(${target})`),15000,'fixture card');
      await js(`document.querySelector(${target}).click(); true`);
      await until(()=>js("!!document.querySelector('.card-files [data-add-file]')"),8000,'attachment picker');
      if (width === 1280) {
        await js(`(()=>{
          const picker=document.querySelector('.card-files input[type=file]');
          const data=new DataTransfer();
          const canvas=document.createElement('canvas');canvas.width=240;canvas.height=120;
          const ctx=canvas.getContext('2d');ctx.fillStyle='#35614d';ctx.fillRect(0,0,240,120);ctx.fillStyle='white';ctx.font='20px sans-serif';ctx.fillText('Review sample',28,66);
          const bytes=Uint8Array.from(atob(canvas.toDataURL().split(',')[1]),c=>c.charCodeAt(0));
          data.items.add(new File([bytes],'sample.png',{type:'image/png'}));
          data.items.add(new File(['sample meeting agenda'],'agenda.txt',{type:'text/plain'}));
          const note=document.querySelector('#note-text');
          if(note){note.value='Meeting screenshot and agenda attached.';note.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true}));return true;}
          picker.files=data.files;picker.dispatchEvent(new Event('change'));return true;
        })()`);
        assert.ok(await js("document.querySelector('[data-upload]')?.disabled"));
        await js("document.querySelector('.modal-body input[type=checkbox]').click(); true");
        if(type === '人類紀錄'){
          await until(()=>js("document.querySelector('.modal-body .card-preview')?.naturalWidth > 0"),5000,'confirmation preview');
          await saveShot(language+'-1280-confirm');
        }
        await js("document.querySelector('[data-upload]').click(); true");
      }
      await until(()=>js("!!document.querySelector('.card-file-row') && document.querySelector('.card-image-grid img')?.naturalWidth > 0"),12000,'uploaded attachments');
      await js("document.querySelector('.card-files').scrollIntoView({block:'center'}); true");
      assert.ok(await js("document.documentElement.scrollWidth <= innerWidth+1"));
      await saveShot([language,width,type==='工作'?'work':'note'].join('-'));
      if(type === '人類紀錄'){
        assert.match(await js("document.querySelector('.note-entry [data-note-file]')?.parentElement.textContent || ''"),/🖼 sample.png/);
        await js("document.querySelector('.note-entry').scrollIntoView({block:'center'});true");
        await saveShot(language+'-'+width+'-note-tag');
      }
      await js("document.querySelector('[data-card-image]').click(); true");
      await until(()=>js("document.querySelector('.card-file-large')?.naturalWidth > 0"),5000,'lightbox');
    }
  }
  console.log('card-attachments-ui-test: passed');
} finally { await kit.stop(); }
