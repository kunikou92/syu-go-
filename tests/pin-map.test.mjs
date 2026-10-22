import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {build} from 'vite';
import {demoKey,savedDemoKey,DEMO_KEY_STORAGE} from '../src/google-maps.ts';
let bundle;
before(async()=>{
  const result=await build({configFile:false,logLevel:'silent',build:{write:false,lib:{entry:'src/pin-map.ts',formats:['iife'],name:'MapTest'}}});
  bundle=(Array.isArray(result)?result[0]:result).output.find(x=>x.type==='chunk').code;
});
function sdk(){
  const views=[],markers=[];
  class MapView{constructor(host,options){this.host=host;this.options=options;this.events={};this.pans=[];views.push(this);}addListener(name,fn){this.events[name]=fn;return{remove:()=>delete this.events[name]};}panTo(p){this.pans.push(p);}}
  class Marker{constructor(options){Object.assign(this,options);this.events={};markers.push(this);}addListener(name,fn){this.events[name]=fn;return{remove:()=>delete this.events[name]};}append(node){this.node=node;}}
  return{api:{Map:MapView,marker:{AdvancedMarkerElement:Marker},event:{trigger(){},clearInstanceListeners(instance){instance.events={};}}},views,markers};
}
function page(loader){
  const dom=new JSDOM('<div id="map"></div>',{url:'https://app.example',runScripts:'outside-only'});dom.window.eval(bundle);const picked=[],selected=[];
  const picker=new dom.window.MapTest.PinMap((p,s)=>picked.push({p,s}),(id,s)=>selected.push({id,s}),()=>{},loader);
  picker.mount(dom.window.document.querySelector('#map'));
  return{dom,picker,picked,selected};
}
const pin=(id='one',roomId='room')=>({id,roomId,name:'集合地点',latitude:35,longitude:139,version:1,createdAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T00:00:00Z'});
const state=()=>({scope:'room:member',pins:[pin()],selected:'one',draft:null,enabled:true});
const click=(lat,lng)=>({latLng:{lat:()=>lat,lng:()=>lng},stop(){}});
test('開く操作まではGoogleへ読み込まず、再描画とモード切り替えで地図を作り直さない',async()=>{
  const fake=sdk();let loads=0;const p=page(async()=>{loads++;return fake.api;});try{
    p.picker.update(state());assert.equal(loads,0);await p.picker.open('test-key');assert.equal(loads,1);assert.equal(fake.views.length,1);
    const next=p.dom.window.document.createElement('div');p.dom.window.document.body.replaceChildren(next);p.picker.mount(next);p.picker.update(state());await p.picker.open('test-key');
    assert.equal(fake.views.length,1);assert.equal(loads,1);
  }finally{p.dom.window.close();}
});
test('地図タップと仮ピンのドラッグから座標を選び、登録済みピンの選択と同期を扱う',async()=>{
  const fake=sdk(),p=page(async()=>fake.api);try{
    p.picker.update(state());await p.picker.open('test-key');fake.views[0].events.click(click(35.1,139.2));assert.equal(p.picked.length,1);
    assert.equal(p.picked[0].s,'room:member');assert.equal(p.picked[0].p.lat,35.1);
    p.picker.update({...state(),draft:{lat:35.1,lng:139.2}});
    const draft=fake.markers.find(m=>m.title==='仮のピン（未登録）');assert.ok(draft.map);draft.events.dragend(click(36,140));assert.equal(p.picked[1].p.lng,140);
    const saved=fake.markers.find(m=>m.title==='案内中：集合地点');saved.events.click();assert.equal(p.selected[0].id,'one');
    p.picker.update({...state(),pins:[{...pin(),name:'変更後',longitude:141}]});assert.equal(saved.position.lng,141);assert.match(saved.title,/変更後/);
    p.picker.update({...state(),pins:[],selected:null});assert.equal(saved.map,null);
  }finally{p.dom.window.close();}
});
test('未確定操作中・不正座標・退出後のタップや遅い読み込みは地点を変更しない',async()=>{
  const fake=sdk();let release;const gate=new Promise(r=>release=r);const p=page(async()=>{await gate;return fake.api;});try{
    p.picker.update(state());const opening=p.picker.open('test-key');p.picker.update({scope:'',pins:[],selected:null,draft:null,enabled:false});release();await opening;assert.equal(fake.views.length,0);
    await p.picker.open('test-key');p.picker.update({...state(),enabled:false});fake.views[0].events.click(click(1,2));assert.equal(p.picked.length,0);
    p.picker.update(state());fake.views[0].events.click(click(91,0));assert.equal(p.picked.length,0);
    p.picker.update({scope:'',pins:[],selected:null,draft:null,enabled:false});fake.views[0].events.click(click(1,2));assert.equal(p.picked.length,0);
  }finally{release();p.dom.window.close();}
});
test('接続失敗は再試行でき、認証・上限のエラーは地図を利用可能と表示しない',async()=>{
  const fake=sdk();let tries=0;const p=page(async()=>{if(++tries===1)throw new Error('接続できません');return fake.api;});try{
    await p.picker.open('test-key');assert.equal(p.picker.available(),false);assert.match(p.picker.message(),/接続できません/);
    await p.picker.open('test-key');assert.equal(p.picker.available(),true);
    p.dom.window.dispatchEvent(new p.dom.window.CustomEvent('syu-go-google-map-error',{detail:'Demo Keyの設定・利用上限を確認してください。'}));
    assert.equal(p.picker.available(),false);assert.match(p.picker.message(),/利用上限/);
    await p.picker.open('test-key');assert.match(p.picker.message(),/再読み込み/);
  }finally{p.dom.window.close();}
});
test('Demo Keyの形式と保存を検査し、SDKの読み込みを1回にまとめてキー変更を拒否する',async()=>{
  const key='AIza'+'b'.repeat(35);assert.equal(demoKey(' '+key+' '),key);assert.throws(()=>demoKey(key+'&callback=bad'));
  assert.equal(savedDemoKey({getItem(){throw new Error('blocked');}}),'');
  const dom=new JSDOM('',{url:'https://app.example',runScripts:'outside-only'}),w=dom.window;
  w.localStorage.setItem(DEMO_KEY_STORAGE,key);assert.equal(savedDemoKey(w.localStorage),key);
  const prior={window:globalThis.window,document:globalThis.document,CustomEvent:globalThis.CustomEvent};
  globalThis.window=w;globalThis.document=w.document;globalThis.CustomEvent=w.CustomEvent;
  try{
    const {loadGoogleMaps}=await import('../src/google-maps.ts?loader-test');
    const a=loadGoogleMaps(key),b=loadGoogleMaps(key);assert.equal(a,b);
    const scripts=w.document.querySelectorAll('script');assert.equal(scripts.length,1);
    assert.equal(new URL(scripts[0].src).origin,'https://maps.googleapis.com');
    assert.equal(new URL(scripts[0].src).searchParams.get('libraries'),'marker');
    const fake=sdk();w.google={maps:fake.api};w.syuGoMapsReady();assert.equal(await a,fake.api);
    assert.equal(await loadGoogleMaps(key),fake.api);assert.equal(w.document.querySelectorAll('script').length,1);
    await assert.rejects(loadGoogleMaps('AIza'+'c'.repeat(35)),/再読み込み/);
  }finally{globalThis.window=prior.window;globalThis.document=prior.document;globalThis.CustomEvent=prior.CustomEvent;w.close();}
});
