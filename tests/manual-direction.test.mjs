import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {build} from 'vite';
import {writeSession} from '../src/membership.ts';

let bundle;
before(async()=>{
  const result=await build({configFile:false,logLevel:'silent',build:{write:false,lib:{entry:'tests/manual-direction-entry.ts',formats:['iife'],name:'ManualTest'}}});
  bundle=(Array.isArray(result)?result[0]:result).output.find(x=>x.type==='chunk').code;
});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function page(permission=async()=>'granted'){
  const dom=new JSDOM('<div id="app"></div>',{url:'https://app.example',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,timers=[];let time=0,calls=0,mode='friends';
  Object.defineProperty(w,'isSecureContext',{value:true});Object.defineProperty(w.performance,'now',{value:()=>time});
  w.DeviceOrientationEvent=class{};w.DeviceOrientationEvent.requestPermission=()=>{calls++;return permission();};
  w.setInterval=fn=>{timers.push(fn);return timers.length;};w.AbortSignal=AbortSignal;
  const now=Date.now(),iso=new Date(now).toISOString(),config={url:'https://example.supabase.co',publicKey:'test'};
  const location={latitude:0,longitude:0,updatedAt:iso,accuracyMeters:1};
  const source={self:location,selfId:'self',roomId:'room',serverTime:now,elapsed:0,members:[{id:'friend',roomId:'room',nickname:'東の友達',locationSharing:true,location:{...location,longitude:.001}}]};
  writeSession(w.localStorage,config.url,{membership:{roomId:'room',participantId:'self',resumeToken:'test'},snapshot:{room:{id:'room',expiresAt:new Date(now+86400000).toISOString()},participant:{id:'self'}},pendingLeave:false,inactive:false});
  w.fetch=async()=>new Response(JSON.stringify({status:'ok',revision:1,mainPinId:'pin',pins:[{id:'pin',roomId:'room',name:'東の集合地点',latitude:0,longitude:.001,createdAt:iso,updatedAt:iso,version:1}]}));
  w.eval(bundle);
  const compass=new w.ManualTest.Compass(()=>{controls.paint();friends.paint();pins.paint();});
  const controls=new w.ManualTest.CompassUI(compass),friends=new w.ManualTest.FriendsUI(()=>source,compass);
  const pins=new w.ManualTest.PinsUI(config,()=>source,()=>render(),compass);
  function render(){w.document.querySelector('#app').innerHTML=controls.content()+(mode==='friends'?friends.content():pins.content());controls.mount();if(mode==='friends')friends.mount();else pins.mount();}
  render();
  const sensor=()=>{const e=new w.Event('deviceorientationabsolute');Object.assign(e,{absolute:true,alpha:180,beta:0,gamma:0});w.dispatchEvent(e);};
  return {w,compass,source,render,sensor,calls:()=>calls,click:id=>w.document.getElementById(id).click(),mode:async m=>{mode=m;render();await tick();},advance:ms=>{time+=ms;timers.forEach(fn=>fn());}};
}
test('未対応・許可拒否でも手動設定でき、東西南北・境界角度とスライダーで矢印を調整する',async()=>{
  const p=page(async()=>'denied');try{
    p.click('compass-start');await tick();assert.match(p.compass.status(),/許可されていません/);
    p.w.DeviceOrientationEvent=undefined;p.click('compass-start');await tick();assert.match(p.compass.status(),/利用できません/);
    p.click('heading-manual');assert.equal(p.compass.heading(),null);assert.equal(p.w.document.querySelector('.friend-row-arrow'),null);
    p.w.document.querySelector('[data-heading="90"]').click();assert.equal(p.compass.heading(),90);
    assert.match(p.w.document.querySelector('.friend-row-arrow').style.transform,/rotate\(0/);
    p.w.document.querySelector('[data-heading="0"]').click();p.click('heading-left');assert.equal(p.compass.heading(),345);
    p.click('heading-right');assert.equal(p.compass.heading(),0);
    const slider=p.w.document.querySelector('#heading-angle');slider.value='270';slider.dispatchEvent(new p.w.Event('input'));
    assert.equal(p.compass.heading(),270);assert.match(p.w.document.querySelector('.friend-row-arrow').style.transform,/180/);
    p.compass.setManual(NaN);assert.equal(p.compass.heading(),270);
    p.advance(6000);assert.equal(p.compass.heading(),270);assert.equal(p.calls(),1);
  }finally{p.w.close();}
});
test('同じ手動方角を両モードへ反映し、位置の鮮度・非公開の制限を維持する',async()=>{
  const p=page();try{
    p.click('heading-manual');p.w.document.querySelector('[data-heading="90"]').click();
    await p.mode('pins');assert.match(p.w.document.querySelector('.pin-direction span').style.transform,/rotate\(0/);
    p.w.document.querySelector('[data-heading="180"]').click();assert.match(p.w.document.querySelector('.pin-direction span').style.transform,/270/);
    await p.mode('friends');assert.match(p.w.document.querySelector('.friend-row-arrow').style.transform,/270/);
    p.source.elapsed=30000;p.advance(0);assert.equal(p.w.document.querySelector('.friend-row-arrow'),null);
    await p.mode('pins');assert.equal(p.w.document.querySelector('.pin-direction'),null);
    p.source.elapsed=0;p.source.self=null;p.advance(0);assert.equal(p.w.document.querySelector('.pin-direction'),null);
  }finally{p.w.close();}
});
test('手動中はセンサーで上書きせず、自動復帰時に新しい許可・方角を待つ',async()=>{
  const p=page();try{
    p.click('compass-start');await tick();p.sensor();assert.equal(p.compass.heading(),180);
    p.click('heading-manual');p.compass.setManual(90);p.sensor();assert.equal(p.compass.heading(),90);
    p.click('heading-auto');assert.equal(p.compass.heading(),null);await tick();assert.equal(p.compass.isManual(),false);
    p.sensor();assert.equal(p.compass.heading(),180);assert.equal(p.calls(),2);
    p.advance(5000);assert.equal(p.compass.heading(),null);
  }finally{p.w.close();}
});
test('遅い許可応答で手動設定を解除せず、画面回転・再表示後は再調整を求める',async()=>{
  let resolve;const p=page(()=>new Promise(r=>{resolve=r;}));try{
    p.click('compass-start');p.click('heading-manual');p.compass.setManual(270);resolve('granted');await tick();p.sensor();
    assert.equal(p.compass.heading(),270);assert.equal(p.compass.busy(),false);
    p.w.dispatchEvent(new p.w.Event('orientationchange'));assert.equal(p.compass.heading(),null);assert.match(p.compass.status(),/指定し直して/);
    p.compass.setManual(90);Object.defineProperty(p.w.document,'hidden',{configurable:true,value:true});p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    assert.equal(p.compass.heading(),null);Object.defineProperty(p.w.document,'hidden',{value:false});p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));assert.equal(p.compass.heading(),null);
  }finally{p.w.close();}
});
