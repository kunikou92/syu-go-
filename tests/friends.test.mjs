import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { directionTo, distanceLabel, compassHeading, markerPositions } from '../src/friends.ts';

let bundle;
before(async()=>{
  const result=await build({configFile:false,logLevel:'silent',build:{write:false,lib:{entry:'src/friends-ui.ts',formats:['iife'],name:'FriendTest'}}});
  bundle=(Array.isArray(result)?result[0]:result).output.find(x=>x.type==='chunk').code;
});
test('既知の座標で距離と東西南北、日付変更線、同一点を計算',()=>{
  const origin={latitude:0,longitude:0};
  for(const [latitude,longitude,bearing] of [[1,0,0],[0,1,90],[-1,0,180],[0,-1,270]]){
    const d=directionTo(origin,{latitude,longitude});assert.ok(Math.abs(d.distance-111195.08)<1);assert.equal(d.bearing,bearing);
  }
  const across=directionTo({latitude:0,longitude:179.9},{latitude:0,longitude:-179.9});assert.ok(across.distance<23000);assert.equal(across.bearing,90);
  assert.equal(directionTo(origin,origin).bearing,null);
  assert.equal(directionTo(origin,{latitude:0,longitude:180}).bearing,null);
  assert.equal(distanceLabel(.1),'1m未満');assert.equal(distanceLabel(123),'約123m');assert.equal(distanceLabel(1234),'約1.2km');
});
test('絶対方位とiPhoneのコンパス、画面の回転、無効・相対・傾斜値を扱う',()=>{
  const e={alpha:270,beta:0,gamma:0,absolute:true};
  assert.equal(compassHeading(e,0),90);assert.equal(compassHeading(e,90),180);
  assert.equal(compassHeading({...e,alpha:1},0),359);
  assert.equal(compassHeading({...e,absolute:false},0),null);
  assert.equal(compassHeading({...e,alpha:null},0),null);
  assert.equal(compassHeading({...e,beta:45},0),null);
  assert.equal(compassHeading({...e,webkitCompassHeading:350,webkitCompassAccuracy:10},90),80);
  assert.equal(compassHeading({...e,webkitCompassHeading:90,webkitCompassAccuracy:-1},0),null);
});
test('9人が同じ方向や0度境界でも番号マーカーを重ねない',()=>{
  for(const angles of [Array(9).fill(0),[359,0,1,2,358,0,1,359,0]]){
    const placed=markerPositions(angles);
    placed.forEach((p,i)=>{assert.ok(Math.hypot(p.x,p.y)<=101);placed.slice(0,i).forEach(q=>assert.ok(Math.hypot(p.x-q.x,p.y-q.y)>=38));});
  }
});
const time=Date.parse('2026-10-22T00:00:00Z');
const loc=(latitude,longitude)=>({latitude,longitude,accuracyMeters:5,updatedAt:new Date(time).toISOString()});
function data(){return {self:loc(0,0),selfId:'self',roomId:'room',serverTime:time,elapsed:0,
  members:[{id:'self',roomId:'room',nickname:'自分',locationSharing:true,location:loc(0,0)},
    {id:'friend',roomId:'room',nickname:'東の友達',locationSharing:true,location:loc(0,.001)}]};}
function page(initial=data(),permission='granted'){
  const dom=new JSDOM('<div id="app"></div>',{url:'https://app.example',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;let current=initial,elapsed=0,calls=0;const timers=[];
  Object.defineProperty(w,'isSecureContext',{value:true});Object.defineProperty(w.performance,'now',{value:()=>elapsed});
  w.setInterval=fn=>{timers.push(fn);return timers.length;};
  w.DeviceOrientationEvent=class{};w.DeviceOrientationEvent.requestPermission=async()=>{calls++;return permission;};
  w.eval(bundle);const ui=new w.FriendTest.FriendsUI(()=>current);
  function render(){w.document.querySelector('#app').innerHTML=ui.content();ui.mount();}render();
  function sensor(alpha=0,options={}){const e=new w.Event('deviceorientationabsolute');Object.assign(e,{alpha,beta:0,gamma:0,absolute:true,...options});w.dispatchEvent(e);}
  return {w,ui,render,sensor,set:v=>{current=v;ui.paint();},advance:ms=>{elapsed+=ms;timers.forEach(fn=>fn());},calls:()=>calls};
}
const settle=()=>new Promise(r=>setTimeout(r,0));
test('許可は操作時だけ求め、友達の名前・距離・相対矢印を表示し、回転と移動で更新',async()=>{
  const p=page();try{
    assert.equal(p.calls(),0);assert.match(p.w.document.querySelector('#friends-list').textContent,/東の友達/);
    assert.equal(p.w.document.querySelectorAll('.friend-row-arrow').length,0);
    p.w.document.querySelector('#compass-start').click();await settle();assert.equal(p.calls(),1);p.sensor(0);
    assert.match(p.w.document.querySelector('.friend-row-arrow').style.transform,/90/);
    p.sensor(270);assert.match(p.w.document.querySelector('.friend-row-arrow').style.transform,/0/);
    const moved=data();moved.members[1].location=loc(.001,0);p.set(moved);
    assert.match(p.w.document.querySelector('.friend-row-arrow').style.transform,/270/);
    const relative=new p.w.Event('deviceorientation');Object.assign(relative,{alpha:0,beta:0,gamma:0,absolute:false});p.w.dispatchEvent(relative);
    assert.equal(p.w.document.querySelectorAll('.friend-row-arrow').length,1);
    p.advance(5000);assert.equal(p.w.document.querySelectorAll('.friend-row-arrow').length,0);
  }finally{p.w.close();}
});
test('自分・他室・非公開・古い位置を除外し、OFFや退出・更新再開に追従',async()=>{
  const d=data();d.members.push({...d.members[1],id:'other',roomId:'other'}, {...d.members[1],id:'off',locationSharing:false});
  const p=page(d);try{
    assert.equal(p.w.document.querySelectorAll('.friend-row').length,1);
    p.set({...d,elapsed:30000});assert.equal(p.w.document.querySelectorAll('.friend-row').length,0);
    p.set(d);assert.equal(p.w.document.querySelectorAll('.friend-row').length,1);
    p.set({...d,self:null});assert.equal(p.w.document.querySelectorAll('.friend-row').length,0);
    p.set({...d,members:[]});assert.match(p.w.document.querySelector('#friends-status').textContent,/案内できる友達がいません/);
    p.set(null);assert.match(p.w.document.querySelector('#friends-status').textContent,/ルームに参加/);
  }finally{p.w.close();}
});
test('許可拒否や未対応では矢印を出さず、名前をHTMLとして解釈しない',async()=>{
  const d=data();d.members[1].nickname='<img src=x onerror=alert(1)>';
  const p=page(d,'denied');try{
    p.w.document.querySelector('#compass-start').click();await settle();p.sensor(0);
    assert.match(p.w.document.querySelector('#compass-status').textContent,/許可されていません/);
    assert.equal(p.w.document.querySelectorAll('img').length,0);assert.equal(p.w.document.querySelectorAll('.friend-row-arrow').length,0);
    p.w.DeviceOrientationEvent=undefined;p.w.document.querySelector('#compass-start').click();await settle();
    assert.match(p.w.document.querySelector('#compass-status').textContent,/利用できません/);
  }finally{p.w.close();}
});
test('同じ位置では不定の矢印を表示せず、名前・距離・位置誤差を案内',async()=>{
  const d=data();d.members[1].location=loc(0,0);const p=page(d);try{
    p.w.document.querySelector('#compass-start').click();await settle();p.sensor(0);
    assert.equal(p.w.document.querySelectorAll('.friend-row-arrow').length,0);
    assert.doesNotMatch(p.w.document.querySelector('#friends-list').textContent,/画面の上から時計回り/);
    assert.match(p.w.document.querySelector('#friends-list').textContent,/誤差/);
  }finally{p.w.close();}
});
