import type { BackendConfig } from './rooms';
import type { Session, RoomStatus } from './membership';
import { activeSession, acceptReply, statusMessages } from './membership';
import type { FriendSource } from './friends-ui';
import type { SharedPin, PinChange, PinReply } from './pins';
import { pinAction, pinFields } from './pins';
import { locationFresh } from './location';
import { Compass } from './compass';
import { degrees, directionTo, distanceLabel } from './friends';
import { PinMap } from './pin-map';
import { demoKey, savedDemoKey, DEMO_KEY_STORAGE, validPoint } from './google-maps';
import type { MapPoint, MapsSDK } from './google-maps';

const html=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const key=(s:Session|null)=>s?`${s.membership.roomId}:${s.membership.participantId}`:'';
const text=(e:Element,v:string)=>{if(e.textContent!==v)e.textContent=v;};
export class PinsUI {
  private session:Session|null=null;
  private scope=''; private generation=0; private revision=-1; private received=0;
  private pins:SharedPin[]=[]; private mainId:string|null=null;
  private ready=false; private reading=false; private saving=false;
  private pending:PinChange|null=null; private message=''; private connectionError=false;
  private draft={name:'',latitude:'',longitude:''};
  private base:SharedPin|null=null; private hasDraft=false;
  private compass:Compass; private mapPicker:PinMap; private mapSetupMessage='';
  private locating=false; private geoAttempt=0; private viewGeneration=0; private autoScope=''; private locationMessage='';
  constructor(private config:BackendConfig|null,private source:()=>FriendSource|null,private redraw:()=>void,
    compass?:Compass,private onTerminal?:(status:RoomStatus)=>void,mapLoader?:(key:string)=>Promise<MapsSDK>){
    this.compass=compass??new Compass(()=>this.paint());
    this.mapPicker=new PinMap((point,scope)=>{if(scope!==key(this.current())||this.saving||this.pending)return;this.setPoint(point);},()=>{},()=>this.paint(),mapLoader);
    window.setInterval(()=>void this.sync(),5000);
    window.setInterval(()=>{this.scopeCheck();this.paint();},250);
    window.addEventListener('online',()=>void this.sync());
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)void this.sync();});
  }
  private current():Session|null {try{const s=this.config&&activeSession(localStorage,this.config.url);return s?.snapshot&&!s.pendingLeave?s:null;}catch{return null;}}
  private pendingKey():string{return `syu-go:${this.config?.url}:pin-change:${this.scope}`;}
  private chosen():SharedPin|null{return this.pins.find(p=>p.id===this.mainId)??this.pins[0]??null;}
  private scopeCheck():void {
    const s=this.current();if(key(s)===this.scope)return;
    this.session=s;this.scope=key(s);this.generation++;this.geoAttempt++;this.locating=false;this.autoScope='';this.locationMessage='';
    this.pins=[];this.mainId=null;this.revision=-1;this.received=0;this.ready=false;this.reading=false;this.saving=false;
    this.pending=null;this.base=null;this.hasDraft=false;this.draft={name:'',latitude:'',longitude:''};this.message='';this.connectionError=false;
    this.mapPicker.update({scope:this.scope,pins:[],selected:null,draft:null,enabled:false});
    try{const raw=localStorage.getItem(this.pendingKey());if(raw)this.pending=JSON.parse(raw) as PinChange;}catch{this.message='前回の操作を読み込めません。ブラウザーの保存設定を確認してください。';}
  }
  enter():void{this.scopeCheck();this.viewGeneration++;this.autoScope='';void this.sync();}
  leave():void{this.viewGeneration++;this.geoAttempt++;this.locating=false;this.autoScope='';}
  content(headingControls=''):string {
    this.scopeCheck();
    return `<section class="card pin-map-card" aria-label="集合地点の地図">
      <div id="pin-map-slot"></div>
      <form id="pin-form" novalidate>
        <div class="pin-create-actions"><button id="pin-use-location" class="button secondary" type="button">現在位置を設定</button><button id="pin-save" class="button" type="submit">集合地点を追加</button></div>
        <p id="pin-map-status" class="hint" role="status"></p><p id="pin-location-status" class="hint" role="status"></p>
        <button id="pin-map-reload" class="button secondary" type="button" hidden>画面を再読み込みする</button>
        <label for="pin-name">ピンの名前(任意)</label><input id="pin-name" value="${html(this.draft.name)}" placeholder="集合地点" aria-describedby="pin-form-status">
        <input id="pin-latitude" type="hidden" value="${html(this.draft.latitude)}"><input id="pin-longitude" type="hidden" value="${html(this.draft.longitude)}">
        <p id="pin-picked-position" class="hint" role="status"></p><p id="pin-form-status" class="notice" role="status" tabindex="-1"></p>
        <button id="pin-retry" class="button secondary" type="button" hidden>前回の操作結果を再確認する</button>
      </form>
      <p id="pins-status" class="hint" role="status"></p>
      <div id="pin-guidance" aria-live="off"></div>
      <button id="pin-compass" class="button secondary" type="button">コンパスを有効にする・再試行</button><p id="pin-compass-status" class="hint" role="status"></p>
      ${headingControls}
      <details class="map-settings" ${savedDemoKey(localStorage)?'':'open'}><summary>確認用の地図設定</summary>
        <p class="hint">GoogleのDemo Keyをこのブラウザーに設定してください。</p><a class="text-link" href="https://developers.google.com/maps/demo-key" target="_blank" rel="noopener noreferrer">Google公式ページでDemo Keyを取得 ↗</a>
        <form id="demo-key-form"><label for="google-demo-key">Demo Key</label><input id="google-demo-key" type="password" autocomplete="off" spellcheck="false" placeholder="${savedDemoKey(localStorage)?'登録済み。変更する場合だけ入力':'取得したDemo Keyを貼り付け'}"><button class="button secondary" type="submit">このブラウザーに保存して地図を開く</button></form>
        <button id="demo-key-remove" class="button secondary" type="button">保存したキーを消す</button><button id="pin-map-open" class="button secondary" type="button">地図を再試行</button><p id="demo-key-status" class="hint" role="status"></p>
        <p class="hint">キーはこのブラウザーだけに保存し、地図の読み込み時にGoogleへ送信します。スマホ側にも設定してください。課金設定や有料キーへの切り替えは行いません。</p>
      </details></section>`;
  }
  mount():void {
    this.mapPicker.mount(document.querySelector('#pin-map-slot'));
    document.querySelector('#pin-map-open')?.addEventListener('click',()=>void this.initializeMap());
    document.querySelector('#pin-map-reload')?.addEventListener('click',()=>window.location.reload());
    document.querySelector('#demo-key-form')?.addEventListener('submit',event=>{event.preventDefault();void this.saveMapKey();});
    document.querySelector('#demo-key-remove')?.addEventListener('click',()=>{try{localStorage.removeItem(DEMO_KEY_STORAGE);this.mapPicker.clear();this.mapSetupMessage='保存したキーを削除しました。';this.redraw();}catch{this.mapSetupMessage='キーを削除できません。';this.paint();}});
    document.querySelector('#pin-form')?.addEventListener('submit',event=>{event.preventDefault();void this.submit();});
    document.querySelector('#pin-retry')?.addEventListener('click',()=>void this.save());
    document.querySelector('#pin-use-location')?.addEventListener('click',()=>void this.locate(true));
    document.querySelectorAll<HTMLInputElement>('#pin-form input').forEach(input=>input.addEventListener('input',()=>{this.captureDraft();this.paint();}));
    this.paint();void this.sync();
    if(this.autoScope!==this.scope || !this.autoScope){this.autoScope=this.scope||'no-room';void this.initializeMap();}
  }
  private visible():boolean{return !!document.querySelector('#pin-map-slot')&&!!this.session&&key(this.current())===this.scope;}
  private async initializeMap():Promise<void>{
    const mapKey=savedDemoKey(localStorage);if(!mapKey){this.paint();return;}
    const generation=this.generation,viewGeneration=this.viewGeneration;
    if(this.visible())await this.locate(false);
    if(generation!==this.generation||viewGeneration!==this.viewGeneration||!document.querySelector('#pin-map-slot'))return;
    await this.mapPicker.open(mapKey);
  }
  private async locate(setPin:boolean):Promise<void>{
    if(!this.visible()||this.locating)return;
    const attempt=++this.geoAttempt,generation=this.generation;
    const valid=()=>attempt===this.geoAttempt&&generation===this.generation&&this.visible();
    this.locating=true;this.locationMessage='現在地を確認しています…';this.paint();
    try{
      const source=this.source();let point:MapPoint;
      if(source?.roomId===this.session!.membership.roomId&&locationFresh(source.self,source.serverTime,source.elapsed))point={lat:source.self!.latitude,lng:source.self!.longitude};
      else{
        if(!window.isSecureContext||!navigator.geolocation)throw new Error('現在地を取得できません。地図を動かして場所を選んでください。');
        point=await new Promise<MapPoint>((resolve,reject)=>{
          const timer=window.setTimeout(()=>reject(new Error('現在地の取得がタイムアウトしました。地図から場所を選べます。')),12000);
          navigator.geolocation.getCurrentPosition(position=>{window.clearTimeout(timer);
            const p={lat:position.coords.latitude,lng:position.coords.longitude},age=Date.now()-position.timestamp;
            if(!validPoint(p)||!Number.isFinite(age)||age< -5000||age>=30000){reject(new Error('新しい現在地を取得できませんでした。もう一度お試しください。'));return;}resolve(p);
          },error=>{window.clearTimeout(timer);reject(new Error(error.code===1?'現在地が許可されていません。地図を動かして場所を選べます。':'現在地を取得できません。地図を動かして場所を選べます。'));},{enableHighAccuracy:true,maximumAge:0,timeout:10000});
        });
      }
      if(!valid())return;
      this.mapPicker.centerOn(point);
      if(setPin)this.setPoint(point);
      this.locationMessage=setPin?'現在位置に仮ピンを置きました。追加・更新ボタンで登録してください。':'現在地を中心に表示しています。地図用の位置はルームへ共有しません。';
    }catch(error){if(valid())this.locationMessage=(error as Error).message;}
    finally{if(attempt===this.geoAttempt){this.locating=false;this.paint();}}
  }
  private async saveMapKey():Promise<void>{
    const input=document.querySelector<HTMLInputElement>('#google-demo-key');if(!input)return;
    try{const value=demoKey(input.value),previous=savedDemoKey(localStorage);localStorage.setItem(DEMO_KEY_STORAGE,value);input.value='';this.mapSetupMessage='Demo Keyを保存しました。';
      if(previous&&previous!==value){this.mapPicker.clear();this.mapSetupMessage='キーを変更しました。画面を再読み込みしてください。';this.paint();return;}await this.initializeMap();
    }catch(error){this.mapSetupMessage=error instanceof Error?error.message:'キーを保存できません。';this.paint();}
  }
  private draftPoint():MapPoint|null {const p={lat:Number(this.draft.latitude),lng:Number(this.draft.longitude)};return this.draft.latitude.trim()&&this.draft.longitude.trim()&&validPoint(p)?p:null;}
  private captureDraft():void {
    const name=document.querySelector<HTMLInputElement>('#pin-name');if(!name)return;
    if(!this.hasDraft){this.base=this.chosen()?{...this.chosen()!}:null;this.hasDraft=true;}
    this.draft={name:name.value,latitude:document.querySelector<HTMLInputElement>('#pin-latitude')!.value,longitude:document.querySelector<HTMLInputElement>('#pin-longitude')!.value};
  }
  private setPoint(point:MapPoint):void {
    this.captureDraft();this.base=this.chosen()?{...this.chosen()!}:null;
    this.draft.latitude=String(point.lat);this.draft.longitude=String(point.lng);
    const lat=document.querySelector<HTMLInputElement>('#pin-latitude'),lng=document.querySelector<HTMLInputElement>('#pin-longitude');if(lat&&lng){lat.value=this.draft.latitude;lng.value=this.draft.longitude;}
    this.paint();
  }
  private apply(reply:PinReply):void{if(reply.revision!<this.revision)return;this.pins=reply.pins!;this.mainId=reply.mainPinId!;this.revision=reply.revision!;this.ready=true;this.received=performance.now();}
  private terminal(reply:PinReply):boolean {
    if(['ok','conflict','pin_missing'].includes(reply.status))return false;
    this.message=reply.status==='invalid_request'?'操作を確認できません。入力を確認してください。':statusMessages[reply.status as RoomStatus];
    if(reply.status!=='invalid_request'&&this.session){const status=reply.status as RoomStatus;acceptReply(localStorage,this.config!.url,this.session,{status});this.onTerminal?.(status);this.scopeCheck();this.redraw();}return true;
  }
  private async sync():Promise<void>{
    this.scopeCheck();const s=this.session;if(!s||!this.config||this.reading)return;
    const generation=this.generation;this.reading=true;
    try{const reply=await pinAction(this.config,s);if(generation!==this.generation||key(s)!==key(this.current()))return;this.connectionError=false;if(!this.terminal(reply))this.apply(reply);}
    catch{if(generation===this.generation)this.connectionError=true;}finally{if(generation===this.generation)this.reading=false;this.paint();}
  }
  private async submit():Promise<void>{
    if(this.saving||this.pending||!this.session||!this.ready)return;
    this.captureDraft();
    try{
      if(!this.draftPoint())throw new Error('場所が未選択です。地図をタップするか「現在位置を設定」を押してください。');
      const fields=pinFields(this.draft.name.trim()||this.base?.name||'集合地点',this.draft.latitude,this.draft.longitude);
      // 新規ピンのIDをルームIDに固定し、同時登録でも別の2地点を作らない。
      const change:PinChange={action:this.base?'update':'create',requestId:crypto.randomUUID(),pinId:this.base?.id??this.session.membership.roomId,version:this.base?.version,...fields};
      try{localStorage.setItem(this.pendingKey(),JSON.stringify(change));}catch{throw new Error('操作を保存できません。ブラウザーの保存を許可してから再試行してください。');}
      this.pending=change;await this.save();
    }catch(error){this.message=(error as Error).message;this.paint();document.querySelector<HTMLElement>('#pin-form-status')?.focus();}
  }
  private async save():Promise<void>{
    const s=this.session,change=this.pending;if(!s||!change||!this.config||this.saving)return;
    const generation=this.generation,storageKey=this.pendingKey();this.saving=true;this.message='集合地点の操作結果を確認しています…';this.paint();
    try{const reply=await pinAction(this.config,s,change);if(generation!==this.generation||key(s)!==key(this.current()))return;
      localStorage.removeItem(storageKey);this.pending=null;this.connectionError=false;if(!this.terminal(reply))this.apply(reply);
      if(reply.status==='ok'){this.message='集合地点を保存しました。';this.base=null;this.hasDraft=false;this.draft={name:'',latitude:'',longitude:''};}
      else if(reply.status==='conflict'||reply.status==='pin_missing')this.message='ほかの参加者が地点を変更しました。地図をタップし直してから、もう一度登録してください。';this.redraw();
    }catch{if(generation===this.generation)this.message='操作結果が未確定です。「前回の操作結果を再確認する」で再試行してください。重複登録しません。';}
    finally{if(generation===this.generation)this.saving=false;this.paint();}
  }
  paint():void {
    const status=document.querySelector('#pins-status');if(!status)return;
    const disabled=!this.session||!this.ready||this.saving||!!this.pending,pin=this.chosen();
    const message=!this.session?'ルームに参加すると集合地点を登録できます。':this.message||(this.connectionError?'集合地点を更新できません。接続が戻り次第、再確認します。':!this.ready?'集合地点を確認しています…':pin?'集合地点を共有しています。':'地図から集合地点を選んでください。');text(status,message);
    text(document.querySelector('#pin-form-status')!,this.message||(!this.session||!this.ready?message:'ピンは1つです。別の場所を登録すると同じピンを更新します。'));
    const save=document.querySelector<HTMLButtonElement>('#pin-save')!;save.disabled=disabled;save.textContent=this.saving?'保存を確認中…':pin?'集合地点を更新':'集合地点を追加';
    const use=document.querySelector<HTMLButtonElement>('#pin-use-location')!;use.disabled=disabled||this.locating;
    document.querySelectorAll<HTMLInputElement>('#pin-form input').forEach(input=>input.disabled=disabled);
    const retry=document.querySelector<HTMLButtonElement>('#pin-retry')!;retry.hidden=!this.pending;retry.disabled=this.saving;
    const mapKey=savedDemoKey(localStorage);text(document.querySelector('#demo-key-status')!,this.mapSetupMessage||(mapKey?'Demo Keyを設定済みです。':'Demo Keyは未設定です。'));
    text(document.querySelector('#pin-map-status')!,mapKey?this.mapPicker.message():'「確認用の地図設定」でDemo Keyを設定してください。');
    text(document.querySelector('#pin-location-status')!,this.locationMessage);
    (document.querySelector('#pin-map-open') as HTMLButtonElement).disabled=!mapKey||this.mapPicker.busy()||this.locating;
    (document.querySelector('#pin-map-reload') as HTMLElement).hidden=!this.mapPicker.message().includes('再読み込み')&&!this.mapSetupMessage.includes('再読み込み');
    (document.querySelector('#pin-map-slot') as HTMLElement).hidden=!mapKey;
    const draft=this.draftPoint();text(document.querySelector('#pin-picked-position')!,draft?'仮ピンを選択中です。追加・更新ボタンで登録してください。':'地図をタップすると仮ピンを置けます。');
    this.mapPicker.update({scope:this.scope,pins:pin&&!draft?[pin]:[],selected:pin?.id??null,draft,enabled:!disabled});
    text(document.querySelector('#pin-compass-status')!,this.compass.status());(document.querySelector('#pin-compass') as HTMLButtonElement).disabled=this.compass.busy();
    const source=this.source(),heading=this.compass.heading();
    const own=source?.roomId===this.session?.membership.roomId&&source&&locationFresh(source.self,source.serverTime,source.elapsed)?source.self:null;
    let markup='<p class="notice">集合地点を登録すると案内を表示します。</p>';
    if(pin){const title=`<h3>${html(pin.name)}</h3>`;
      if(!own)markup=title+'<p class="notice">自分の新しい位置が必要です。位置公開をONにしてください。</p>';
      else if(performance.now()-this.received>=30000)markup=title+'<p class="notice">集合地点の更新が止まっています。接続が戻るまで案内を隠します。</p>';
      else{const d=directionTo(own,pin),angle=heading!==null&&d.bearing!==null?degrees(d.bearing-heading):null;
        markup=`<div class="pin-destination">${title}<p class="friend-distance">${distanceLabel(d.distance)}</p>${angle===null?'':`<div class="pin-direction" role="img" aria-label="${html(pin.name)}の方向：画面の上から時計回りに約${Math.round(angle)%360}度"><span style="transform:rotate(${angle.toFixed(2)}deg)">↑</span></div>`}<p class="hint">${d.bearing===null?'すぐ近くか、方角を確定できない地点です。':angle===null?'コンパスの方角を待っています。距離のみ表示します。':'位置や方角には誤差があります。'}</p></div>`;}
    }
    const guide=document.querySelector('#pin-guidance')!;if(guide.innerHTML!==markup)guide.innerHTML=markup;
  }
}
