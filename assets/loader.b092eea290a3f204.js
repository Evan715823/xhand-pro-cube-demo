/* Static-host loader. The compressed recording is identical to the offline HTML. */
(()=>{'use strict';
const $=id=>document.getElementById(id);
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const digest=bytes=>crypto.subtle.digest('SHA-256',bytes).then(hex);
const stats=window.REPLAY_DOWNLOAD={bytes:0,total:0,parts:0,retries:0,verified:false};
function progress(){
  $('load-progress').value=stats.total?stats.bytes/stats.total:0;
  $('load-detail').textContent=`${(stats.bytes/1e6).toFixed(1)} / ${(stats.total/1e6).toFixed(1)} MB`;
}
window.showReplayError=error=>{
  $('load-title').textContent='回放加载失败';
  $('load-detail').textContent='请检查网络连接，然后重试。';
  $('load-retry').hidden=false;
  $('load-retry').onclick=()=>location.reload();
};
window.loadReplayBytes=async()=>{
  const manifestURL=new URL(document.querySelector('meta[name="replay-manifest"]').content,location.href);
  const response=await fetch(manifestURL);
  if(!response.ok)throw new Error('Replay manifest HTTP '+response.status);
  const manifest=await response.json();
  if(manifest.schema!==1||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<=0||manifest.bytes>256*1024*1024||!Array.isArray(manifest.parts))throw new Error('Invalid replay manifest');
  let end=0;
  for(const part of manifest.parts){
    const url=new URL(part.file,manifestURL);
    if(url.origin!==location.origin||part.offset!==end||!Number.isSafeInteger(part.bytes)||part.bytes<=0||!/^[a-f0-9]{64}$/.test(part.sha256))throw new Error('Invalid replay part');
    end+=part.bytes;
  }
  if(end!==manifest.bytes||!/^[a-f0-9]{64}$/.test(manifest.sha256))throw new Error('Invalid recording size');
  stats.total=manifest.bytes;progress();
  const bytes=new Uint8Array(manifest.bytes);
  async function download(part){
    for(let attempt=0;attempt<3;attempt++){
      let received=0;
      try{
        const result=await fetch(new URL(part.file,manifestURL),{cache:attempt?'reload':'default',signal:AbortSignal.timeout(120000)});
        if(!result.ok||!result.body)throw new Error('Replay part HTTP '+result.status);
        const reader=result.body.getReader();
        try{
          while(true){
            const {done,value}=await reader.read();if(done)break;
            if(received+value.length>part.bytes)throw new Error('Oversized replay part');
            bytes.set(value,part.offset+received);received+=value.length;stats.bytes+=value.length;progress();
          }
        }finally{await reader.cancel();reader.releaseLock()}
        if(received!==part.bytes||await digest(bytes.subarray(part.offset,part.offset+part.bytes))!==part.sha256)throw new Error('Replay checksum mismatch');
        stats.parts++;return;
      }catch(error){
        stats.bytes-=received;progress();
        if(attempt===2)throw error;
        stats.retries++;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
      }
    }
  }
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,manifest.parts.length)},async()=>{
    while(cursor<manifest.parts.length){const part=manifest.parts[cursor++];await download(part)}
  }));
  if(await digest(bytes)!==manifest.sha256)throw new Error('Recording checksum mismatch');
  stats.verified=true;
  $('load-title').textContent='正在准备三维回放';
  $('load-detail').textContent='下载完成';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return bytes;
};
})();
