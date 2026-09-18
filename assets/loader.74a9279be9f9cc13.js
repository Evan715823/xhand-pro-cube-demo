/* Bounded replay streaming: exact recorded 50 Hz poses, three segments in memory. */
(()=>{'use strict';
const $=id=>document.getElementById(id),decoder=new TextDecoder();
const hex=buffer=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('');
const digest=bytes=>crypto.subtle.digest('SHA-256',bytes).then(hex);
const stats=window.REPLAY_DOWNLOAD={bytes:0,total:0,parts:0,retries:0,verified:false,mode:'streaming',cachedPoseBytes:0,maxCachedPoseBytes:0};
let manifestURL,manifest,starting=true;
function progress(){
  if(!starting)return;
  $('load-progress').value=stats.total?Math.min(1,stats.bytes/stats.total):0;
  $('load-detail').textContent=`${(stats.bytes/1e6).toFixed(1)} / ${(stats.total/1e6).toFixed(1)} MB`;
}
window.showReplayError=error=>{
  $('load-title').textContent='回放加载失败';
  $('load-detail').textContent=/WebGL|context/i.test(String(error))?'当前浏览器无法启用三维显示，请用 Safari 打开。':'网络中断或浏览器不兼容，请重试或用 Safari 打开。';
  $('load-retry').hidden=false;$('load-retry').onclick=()=>location.reload();
};
async function fetchBytes(url,expected){
  for(let attempt=0;attempt<3;attempt++){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
    let received=0;
    try{
      const response=await fetch(url,{cache:attempt?'reload':'default',signal:controller.signal});
      if(!response.ok)throw new Error('HTTP '+response.status);
      let bytes;
      if(expected&&response.body&&response.body.getReader){
        bytes=new Uint8Array(expected.bytes);const reader=response.body.getReader();
        try{while(true){const {done,value}=await reader.read();if(done)break;if(received+value.length>bytes.length)throw new Error('Asset size mismatch');bytes.set(value,received);received+=value.length;stats.bytes+=value.length;progress()}}
        finally{await reader.cancel();reader.releaseLock()}
        if(received!==bytes.length)throw new Error('Incomplete asset');
      }else{bytes=new Uint8Array(await response.arrayBuffer());received=bytes.length;stats.bytes+=received;progress()}
      if(expected&&(bytes.length!==expected.bytes||await digest(bytes)!==expected.sha256))throw new Error('Asset checksum mismatch');
      if(expected)stats.parts++;
      return bytes;
    }catch(error){stats.bytes-=received;progress();if(attempt===2)throw error;stats.retries++;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)))}
    finally{clearTimeout(timer)}
  }
}
async function inflate(bytes){
  if(typeof DecompressionStream==='function')return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return window.fflate.gunzipSync(bytes);
}
function assetURL(asset){const url=new URL(asset.file,manifestURL);if(url.origin!==location.origin||!Number.isSafeInteger(asset.bytes)||asset.bytes<=0||asset.bytes>32*1024*1024||!/^[a-f0-9]{64}$/.test(asset.sha256))throw new Error('Invalid asset manifest');return url}
window.loadReplayData=async()=>{
  if(!window.crypto?.subtle)throw new Error('Secure browser context required');
  manifestURL=new URL(document.querySelector('meta[name="replay-manifest"]').content,location.href);
  const response=await fetchBytes(manifestURL);manifest=JSON.parse(decoder.decode(response));
  if(manifest.schema!==2||!Array.isArray(manifest.segments)||manifest.frame_count<=0||manifest.body_count<=0)throw new Error('Invalid replay manifest');
  stats.bytes=0;stats.total=manifest.metadata.bytes+manifest.segments[0].bytes;
  const meta=JSON.parse(decoder.decode(await inflate(await fetchBytes(assetURL(manifest.metadata),manifest.metadata))));
  const cache=new Map();let inflight=null,desired=0;
  function metrics(){stats.cachedPoseBytes=Array.from(cache.values()).reduce((sum,s)=>sum+s.poses.byteLength,0);stats.maxCachedPoseBytes=Math.max(stats.maxCachedPoseBytes,stats.cachedPoseBytes)}
  function touch(index){const item=cache.get(index);if(item){cache.delete(index);cache.set(index,item)}return item}
  async function readSegment(index){
    const asset=manifest.segments[index],raw=await inflate(await fetchBytes(assetURL(asset),asset));
    const jsonSize=new DataView(raw.buffer,raw.byteOffset,4).getUint32(0,true);
    if(jsonSize>raw.length-4)throw new Error('Invalid segment header');
    const frames=JSON.parse(decoder.decode(raw.subarray(4,4+jsonSize))),packed=raw.subarray(4+jsonSize);
    const width=manifest.body_count*7,n=asset.count*width;
    if(packed.length!==n*4||frames.length!==asset.count)throw new Error('Invalid segment shape');
    const decoded=new Uint8Array(packed.length);
    for(let lane=0;lane<4;lane++)for(let i=0;i<n;i++)decoded[i*4+lane]=packed[lane*n+i];
    const words=new Uint32Array(decoded.buffer);
    for(let i=width;i<n;i++)words[i]^=words[i-width];
    if(await digest(decoded)!==asset.poses_sha256)throw new Error('Decoded pose checksum mismatch');
    const item={start:asset.start,frames,poses:new Float32Array(decoded.buffer)};cache.set(index,item);
    while(cache.size>3)cache.delete(cache.keys().next().value);
    metrics();return item;
  }
  const indexOf=frame=>Math.floor(frame/manifest.segment_frames);
  async function ensure(frame,priority=true){
    const index=indexOf(frame);if(priority)desired=index;
    if(cache.has(index))return touch(index);
    while(inflight){await inflight.catch(()=>{});if(priority&&desired!==index)return null;if(cache.has(index))return touch(index);if(!priority)return null}
    if(priority&&desired!==index)return null;
    const job=readSegment(index);inflight=job;
    try{return await job}finally{if(inflight===job)inflight=null}
  }
  window.REPLAY_STREAM={
    has:frame=>cache.has(indexOf(frame)),ensure,
    segment:frame=>touch(indexOf(frame)),localIndex:frame=>frame-manifest.segments[indexOf(frame)].start,
    prefetch:frame=>{const index=indexOf(frame);if(frame-manifest.segments[index].start>manifest.segment_frames/2&&index+1<manifest.segments.length&&!inflight&&!cache.has(index+1))ensure(manifest.segments[index+1].start,false).catch(()=>{})},
    state:()=>({segments:cache.size,cachedPoseBytes:stats.cachedPoseBytes,maxCachedPoseBytes:stats.maxCachedPoseBytes,frameCount:manifest.frame_count,segmentFrames:manifest.segment_frames})
  };
  await ensure(0);stats.verified=true;stats.startupBytes=stats.bytes;starting=false;
  $('load-title').textContent='正在准备三维回放';$('load-detail').textContent='首段已就绪';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return meta;
};
})();
